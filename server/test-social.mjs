// Friends & Chat tests: a real server (embedded Postgres on disk) and real WebSocket clients. Discord is a stand-in object
// that only writes down what the mod log was sent: nothing here leaves this machine.
//   node server/test-social.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

for (const k of Object.keys(process.env)) if (/^DISCORD_/.test(k) || k === 'ADMIN_USERS' || k === 'TRUST_PROXY') delete process.env[k];
const { startServer } = await import('./index.mjs');
const { D } = await import('../src/js/engine/data.js');
const { isUnit, itemDef, itemValue, makeCharmItem, makeSkinItem, makeSlabItem } = await import('../src/js/engine/items.js');
const { textProblem } = await import('../src/js/engine/tools.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-social-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };
const READS = new Set(['home', 'find', 'profile', 'unit']);
// Asks until a refusal: how many got through, and what stopped it.
const tries = async (n, fn) => { let ok = 0, stop = null; for (let i = 0; i < n && !stop; i++) { const e = await refused(fn(i)); if (e) stop = e; else ok++; } return { ok, stop }; };
const logs = [];
const start = () => startServer({ port: 0, db: { dataDir: DIR }, log: (...a) => logs.push(a.join(' ')), priceRefresh: false, admins: ['Boss'], discord: false, release: false });

let server = await start();
const base = () => `http://localhost:${server.port}`;
// (the rate limits' clock: it only moves when a test says so, past a window instead of waiting it out)
let clock = Date.now();
const useClock = () => { server.srv.social.now = () => clock; };
const passTime = (ms) => { clock += ms; };
useClock();
const modLog = [];
const fakeDiscord = () => { server.admin.discord = { ...server.discord, enabled: true, modLog: async (m) => { modLog.push(m); return true; } }; };
fakeDiscord();

const register = async (name) => {
  const r = await fetch(base() + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password: 'secret123' }) });
  const b = await r.json();
  if (!b.token) throw new Error('could not register ' + name + ': ' + JSON.stringify(b));
  return b.token;
};
// A game: WebSocket, rpc and everything pushed to it. `app` left out: as the tests of the other suites.
async function client(token) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
  const c = { ws, events: [], pending: new Map(), seq: 0, closed: false };
  ws.on('close', () => { c.closed = true; });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const welcome = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.user = m.user; c.st = m.state; res(m); return; }
      if (m.t === 'fatal') { rej(new Error(m.error)); return; }
      if (m.t === 'res') { const p = c.pending.get(m.id); c.pending.delete(m.id); m.ok ? p.res(m.r) : p.rej(Object.assign(new Error(m.err), { code: m.code })); return; }
      c.events.push(m);
    });
  });
  ws.send(JSON.stringify({ t: 'hello', token, data: D.generatedAt, v: 1 }));
  c.welcome = await welcome;
  c.id = c.user.id;
  const ask = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  // (the connection's own limit, 20 requests a second, isn't what's tested here: these tests just ask quicker than a player)
  c.rpc = async (ns, m, args) => { for (;;) { try { return await ask(ns, m, args); } catch (e) { if (e.message !== 'Slow down a little') throw e; await wait(200); } } };
  // (what's only read has limits of its own: every test but theirs starts with a clean record, and `raw` is for theirs)
  c.raw = (m, a = {}) => c.rpc('social', m, a);
  c.s = (m, a = {}) => { if (READS.has(m)) server.srv.social.hits.delete(`${m}:${c.id}`); return c.raw(m, a); };
  c.admin = (m, a = {}) => c.rpc('admin', m, a);
  c.waitFor = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = c.events.find(pred); if (e) return e; await wait(10); } return null; };
  c.pushed = (t) => c.events.filter((e) => e.t === t);
  c.forget = () => { c.events.length = 0; };
  c.close = () => ws.close();
  return c;
}
const send = (c, to, text) => c.s('chat.send', { id: to.id ?? to, text });
const ids = (list) => list.map((p) => p.id);
// The rate limit out of the way, for the tests that aren't about it.
const fresh = () => passTime(3600000 + 1000);
const count = async (sql, p) => (await server.db.query(sql, p)).rows[0].n;
const conversationSize = (x, y) => count('SELECT count(*)::int AS n FROM messages WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)', [x.id, y.id]);
const giveItems = (c, items) => server.store.withUser(c.id, async (e) => { e.st.inv.unshift(...items); server.store.markDirty(e); });
const aSkin = (n = 0) => makeSkinItem(Object.values(D.skins).filter((s) => itemValue(makeSkinItem(s)) > 0)[n], { src: 'test' });

try {
  const tok = {};
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'Boss', 'moddy', 'ghost', 'zed_x', 'zedxy']) tok[n] = await register(n);
  const alice = await client(tok.alice), bob = await client(tok.bob), carol = await client(tok.carol), dave = await client(tok.dave);
  const erin = await client(tok.erin), boss = await client(tok.Boss), moddy = await client(tok.moddy);
  const { rows: [{ id: ghostId }] } = await server.db.query("SELECT id FROM users WHERE name_lc = 'ghost'"); // (never connected)

  // ---- the tables -------------------------------------------------------------------------------------------------
  const tables = (await server.db.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.t);
  check('the tables: friends, blocks, messages and reports, and users.profile', ['friends', 'blocks', 'messages', 'reports'].every((t) => tables.includes(t))
    && await count("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'profile'") === 1);
  const fks = (await server.db.query(`SELECT c.conrelid::regclass::text AS t, c.confdeltype AS del FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('friends', 'blocks', 'messages', 'reports')`)).rows;
  check('every foreign key on them cascades on delete', fks.length >= 8 && fks.every((f) => f.del === 'c'), `${fks.length} keys`);

  // ---- home and Persons -------------------------------------------------------------------------------------------
  const h0 = await alice.s('home');
  const personKeys = 'avatar,country,id,level,name,online,seen';
  check('home: a new player has empty lists, Everyone as the setting, and a Person of their own',
    h0.me.id === alice.id && h0.me.name === 'alice' && Object.keys(h0.me).sort().join() === personKeys && h0.me.online === true && h0.me.level >= 1 && typeof h0.me.seen === 'number'
    && [h0.friends, h0.requests, h0.sent, h0.blocked, h0.chats].every((l) => Array.isArray(l) && !l.length) && h0.settings.dms === 'everyone', JSON.stringify(h0.me));
  check('an unknown social request is refused, and the db.* ones still answer', /Unknown request/.test((await refused(alice.s('nope')))?.message) && typeof (await alice.s('db.index')).players === 'number');
  // (nobody has a skin yet)
  const noFloats = await alice.s('db.floats', { dir: 'low' }), noHigh = await alice.s('db.floats', { dir: 'high', cat: 'st', limit: 5 });
  check('float records: an empty server has none, either way, and says which list it is', Array.isArray(noFloats.copies) && !noFloats.copies.length && !noHigh.copies.length
    && noFloats.dir === 'low' && noFloats.cat === 'all' && noHigh.dir === 'high' && noHigh.cat === 'st', JSON.stringify([noFloats, noHigh]));

  // ---- find -------------------------------------------------------------------------------------------------------
  const online = await alice.s('find', { q: '' });
  check('find: empty, who\'s online and not you', online.every((p) => p.online) && ids(online).includes(bob.id) && !ids(online).includes(alice.id) && !ids(online).includes(ghostId));
  const zed = await alice.s('find', { q: 'zed' });
  check('find: by username, any case, offline players too', ids(await alice.s('find', { q: 'GHOS' })).includes(ghostId) && zed.length === 2 && zed.every((p) => !p.online));
  check('find: % and _ are plain characters', (await alice.s('find', { q: '%' })).length === 0 && (await alice.s('find', { q: 'zed_' })).map((p) => p.name).join() === 'zed_x');
  const zedClient = await client(tok.zedxy);
  check('find: online first', (await alice.s('find', { q: 'zed' }))[0].name === 'zedxy');
  zedClient.close();
  await server.db.query(`INSERT INTO users (name, name_lc, pass, state, created, last_seen) SELECT 'crowd' || g, 'crowd' || g, 'x', '{}'::jsonb, 1, 1 FROM generate_series(1, 35) g`);
  check('find: at most 30', (await alice.s('find', { q: 'crowd' })).length === 30);
  await server.db.query("DELETE FROM users WHERE name_lc LIKE 'crowd%'");

  // ---- profiles ---------------------------------------------------------------------------------------------------
  await giveItems(alice, [aSkin(0), aSkin(1), aSkin(2), aSkin(3), aSkin(4), aSkin(5), aSkin(6), aSkin(7)]);
  const stored = aSkin(8);
  await server.store.withUser(alice.id, async (e) => { e.st.stored = [...(e.st.stored || []), { ...stored, in: 'x' }]; e.st.prof = { ...e.st.prof, medals: 2 }; server.store.markDirty(e); });
  const pa = await bob.s('profile', { id: alice.id });
  const need = ['bio', 'bg', 'medal', 'medals', 'joined', 'showcase', 'inv', 'value', 'friends', 'relation', 'blockedByMe', ...personKeys.split(',')];
  check('profile: a Person plus everything the page shows', need.every((k) => k in pa) && pa.name === 'alice' && pa.relation === 0 && pa.blockedByMe === false && pa.friends === 0 && pa.medals === 2 && pa.medal?.y != null
    && pa.joined === new Date().getFullYear(), Object.keys(pa).join());
  check('profile: no money, password or anything else of the account', !('money' in pa) && !('pass' in pa) && !('state' in pa) && !('dms' in pa) && !JSON.stringify(pa).includes('"src"'));
  check('profile: stored items aren\'t shown, in the inventory or its value', !pa.inv.some((i) => i.uid === stored.uid) && itemValue(stored) > 0 && Math.abs(pa.value - pa.inv.reduce((t, i) => t + itemValue(i), 0)) < 0.01, `${pa.value}`);
  // Their Storage Units: listed with what each holds, and one can be opened.
  const unitUid = 'test-unit', inside = [aSkin(9), aSkin(10)].map((it, i) => ({ ...it, src: 'a secret', su: unitUid, sat: 1000 + i }));
  await server.store.withUser(alice.id, async (e) => {
    e.st.inv.push({ uid: unitUid, t: 'unit', id: 'storage-unit', name: 'my <b>stash', mod: 5, at: 1, src: 'Store' }, { uid: 'test-empty', t: 'unit', id: 'storage-unit', at: 1 });
    e.st.stored.push(...inside);
    server.store.markDirty(e);
  });
  const withUnits = await bob.s('profile', { id: alice.id });
  const listed = withUnits.units.find((u) => u.uid === unitUid), worth = inside.reduce((t, i) => t + itemValue(i), 0);
  check('profile: their Storage Units, with how much is in each and what it\'s worth', withUnits.units.length === 2 && listed?.name === 'my <b>stash' && listed.n === 2 && Math.abs(listed.value - worth) < 0.01 && listed.mod === 5 && !('src' in listed) && withUnits.units.find((u) => u.uid === 'test-empty')?.n === 0, JSON.stringify(listed));
  check('profile: what\'s stored is added up apart, and isn\'t in the inventory\'s count or value', withUnits.stored.count === 3 && Math.abs(withUnits.stored.value - worth - itemValue(stored)) < 0.01 && withUnits.count === pa.count && !withUnits.inv.some((i) => i.t === 'unit' || i.su) && Math.abs(withUnits.value - pa.value) < 0.01, JSON.stringify(withUnits.stored));
  const opened = await bob.s('unit', { id: alice.id, uid: unitUid });
  check('unit: what\'s in it, as a profile shows items, with when each went in', opened.items.length === 2 && opened.items.every((i) => i.uid && i.t && i.id && !('src' in i) && !('su' in i)) && opened.items.map((i) => i.sat).join() === '1000,1001' && !JSON.stringify(opened).includes('a secret'), JSON.stringify(opened.items[0]));
  check('unit: an empty one opens too', (await bob.s('unit', { id: alice.id, uid: 'test-empty' })).items.length === 0);
  check('unit: not one they don\'t have, an item that isn\'t a unit, a player who doesn\'t exist, or anything that isn\'t an id', (await refused(bob.s('unit', { id: alice.id, uid: 'nope' })))?.code === 'missing' && (await refused(bob.s('unit', { id: alice.id, uid: pa.inv[0].uid })))?.code === 'missing'
    && (await refused(bob.s('unit', { id: 999999, uid: unitUid })))?.code === 'missing' && !!(await refused(bob.s('unit', { id: 'x', uid: unitUid }))) && (await refused(bob.s('unit', { id: alice.id, uid: { a: 1 } })))?.code === 'missing' && (await refused(bob.s('unit', { id: alice.id })))?.code === 'missing');
  await server.store.withUser(alice.id, async (e) => {
    e.st.inv = e.st.inv.filter((i) => i.t !== 'unit');
    e.st.stored = e.st.stored.filter((i) => i.su !== unitUid);
    server.store.markDirty(e);
  });
  check('profile: items as publicCopy (a uid, what it is, no `src`)', pa.inv.length >= 8 && pa.inv.every((i) => i.uid && i.t && i.id && !('src' in i) && !('lk' in i)));
  check('profile: the showcase is their six most valuable until they pick', pa.showcase.length === 6 && pa.picked === false && pa.value > 0);
  check('profile: an unknown player is refused, and a bad id', (await refused(bob.s('profile', { id: 999999 })))?.code === 'missing' && !!(await refused(bob.s('profile', { id: 'x' }))));

  // A slab, a charm and a charmed gun, as the player looking at them gets them: as much as their card and price need.
  const charmDefs = Object.values(D.charms), slabbed = Object.values(D.stickers).find((x) => x.p > 0);
  const charm = makeCharmItem(charmDefs[0], { pat: 1 }), slab = makeSlabItem(slabbed.id, { pat: 5 });
  const { uid: _u, t: _t, ...kc } = makeCharmItem(charmDefs[1], { src: 'a case of theirs', pat: 7 });
  const gun = { ...aSkin(10), kc };
  await giveItems(erin, [charm, slab, gun]);
  const pe = await bob.s('profile', { id: erin.id }), inProfile = (it) => pe.inv.find((i) => i.uid === it.uid);
  check('profile: a Sticker Slab keeps its sticker: its name, picture and price', itemDef(inProfile(slab))?.slab === true && itemValue(inProfile(slab)) === itemValue(slab) && itemValue(slab) > 0, JSON.stringify(inProfile(slab)));
  check('profile: a charm keeps its pattern, and with it its price', inProfile(charm).pat === 1 && itemValue(inProfile(charm)) === itemValue(charm));
  check('profile: a gun keeps its charm, and with it its price, but not where the charm came from', inProfile(gun).kc?.id === kc.id && inProfile(gun).kc.pat === 7 && itemValue(inProfile(gun)) === itemValue(gun) && !JSON.stringify(pe).includes('"src"'), JSON.stringify(inProfile(gun).kc));
  check('profile: card prices add up to the inventory value it shows', Math.abs(pe.value - pe.inv.reduce((t, i) => t + itemValue(i), 0)) < 0.01, `${pe.value}`);

  // A full inventory: the most valuable 300 go out, and what they add up to is everything's.
  const kinds = Array.from({ length: 40 }, (_, i) => aSkin(i));
  await giveItems(dave, Array.from({ length: 310 }, (_, i) => ({ ...kinds[i % 40], uid: `bulk${i}` })));
  const allOfDave = server.store.cache.get(dave.id).st.inv.filter((i) => !isUnit(i));
  const pd = await bob.s('profile', { id: dave.id }), worths = pd.inv.map(itemValue), most = allOfDave.map(itemValue).sort((x, y) => y - x);
  check('profile: at most 300 items, the most valuable, in order', allOfDave.length > 300 && pd.inv.length === 300 && worths.every((v, i) => !i || worths[i - 1] >= v) && Math.abs(worths[0] - most[0]) < 0.01 && Math.abs(worths[299] - most[299]) < 0.01, `${pd.inv.length} of ${allOfDave.length}`);
  check('profile: the count and value are of everything, not those', pd.count === allOfDave.length && Math.abs(pd.value - allOfDave.reduce((t, i) => t + itemValue(i), 0)) < 0.01, `${pd.count} ${pd.value}`);
  const { rows: [{ id: zedOffline }] } = await server.db.query("SELECT id FROM users WHERE name_lc = 'zed_x'");
  const pz = await bob.s('profile', { id: zedOffline });
  check('profile: of a player who isn\'t on: from their row, and not left in memory', pz.name === 'zed_x' && pz.level >= 1 && Array.isArray(pz.inv) && !server.store.cache.has(zedOffline));

  const uids = pa.inv.map((i) => i.uid);
  const saved = await alice.s('profile.set', { bio: 'hello <b>there</b> & "you"\r\n\r\n\r\n\r\nline two', country: 'DE', avatar: Object.keys(D.agents)[0], bg: 'de_dust2', showcase: [uids[0], uids[1], 'nope', stored.uid], dms: 'everyone' });
  check('profile.set: saved as sent (nothing escaped), breaks tidied, and only your own items outside Storage Units in the showcase',
    saved.bio === 'hello <b>there</b> & "you"\n\nline two' && saved.country === 'DE' && saved.avatar === Object.keys(D.agents)[0] && saved.bg === 'de_dust2' && saved.showcase.join() === [uids[0], uids[1]].join(), JSON.stringify(saved));
  const pa2 = await bob.s('profile', { id: alice.id });
  check('profile: shows what was saved, the picked showcase first', pa2.bio === saved.bio && pa2.country === 'DE' && pa2.bg === 'de_dust2' && pa2.avatar === saved.avatar && pa2.showcase.map((i) => i.uid).join() === [uids[0], uids[1]].join() && pa2.picked === true);
  check('a Person carries the avatar and country', (await bob.s('find', { q: 'alice' }))[0].country === 'DE' && (await bob.s('find', { q: 'alice' }))[0].avatar === saved.avatar);
  await alice.s('profile.set', { country: '' });
  const pa3 = await bob.s('profile', { id: alice.id });
  check('profile.set: what isn\'t sent stays', pa3.bio === saved.bio && pa3.avatar === saved.avatar && pa3.country === '');
  const setRefusals = [{ bio: 'you are a fag' }, { bio: 5 }, { bio: 'x'.repeat(301) }, { bio: 'a‮b' }, { bio: 'a\u0007b' }, { country: 'germany' }, { country: 7 }, { country: ['GB'] }, { avatar: 'nope' }, { avatar: '__proto__' }, { bg: '../x' }, { bg: 7 }, { showcase: 'x' }, { showcase: Array(7).fill('x') }, { dms: 'nobody' }];
  const notRefused = [];
  for (const a of setRefusals) if (!(await refused(alice.s('profile.set', a)))) notRefused.push(JSON.stringify(a));
  check(`profile.set: refuses what it should (${setRefusals.length})`, !notRefused.length, notRefused.join(' '));
  check('profile.set: a summary can be emptied, and "grape" isn\'t a slur', (await alice.s('profile.set', { bio: '' })).bio === '' && (await alice.s('profile.set', { bio: 'I like grape juice' })).bio === 'I like grape juice');
  const mine = await alice.s('profile', { id: alice.id });
  check('your own profile: relation 0, not blocked, and yours to read', mine.relation === 0 && mine.blockedByMe === false && mine.name === 'alice');

  // ---- friends ----------------------------------------------------------------------------------------------------
  alice.forget(); bob.forget();
  check('friend: asking gives relation 3 and tells both', (await alice.s('friend', { id: bob.id, on: true })).relation === 3 && !!(await alice.waitFor((e) => e.t === 'friends')) && !!(await bob.waitFor((e) => e.t === 'friends')));
  check('friend: it shows in sent and requests, and as relation 3 and 2', ids((await alice.s('home')).sent).join() === String(bob.id) && ids((await bob.s('home')).requests).join() === String(alice.id)
    && (await alice.s('profile', { id: bob.id })).relation === 3 && (await bob.s('profile', { id: alice.id })).relation === 2);
  check('friend: asking twice changes nothing', (await alice.s('friend', { id: bob.id, on: true })).relation === 3 && await count('SELECT count(*)::int AS n FROM friends') === 1);
  check('friend: the row is one per pair with a < b, and says who asked', (await server.db.query('SELECT a, b, asked_by, status FROM friends')).rows.every((r) => r.a < r.b && r.asked_by === alice.id && r.status === 'pending'));
  check('friend: the other side accepts by asking', (await bob.s('friend', { id: alice.id, on: true })).relation === 1);
  const af = await alice.s('home');
  check('friend: friends on both sides, nothing pending', ids(af.friends).join() === String(bob.id) && !af.sent.length && ids((await bob.s('home')).friends).join() === String(alice.id) && !(await bob.s('home')).requests.length);
  check('friend: the count on a profile and relation 1', (await carol.s('profile', { id: alice.id })).friends === 1 && (await alice.s('profile', { id: bob.id })).relation === 1);
  alice.forget(); bob.forget();
  check('friend: off removes a friend and tells both', (await alice.s('friend', { id: bob.id, on: false })).relation === 0 && !!(await bob.waitFor((e) => e.t === 'friends')) && !(await bob.s('home')).friends.length);
  await carol.s('friend', { id: dave.id, on: true });
  await dave.s('friend', { id: carol.id, on: false });
  check('friend: off declines a request', !(await carol.s('home')).sent.length && !(await dave.s('home')).requests.length);
  await carol.s('friend', { id: dave.id, on: true });
  await carol.s('friend', { id: dave.id, on: false });
  check('friend: off cancels your own', !(await dave.s('home')).requests.length);
  check('friend: not yourself, nobody, or without on', !!(await refused(alice.s('friend', { id: alice.id, on: true }))) && (await refused(alice.s('friend', { id: 999999, on: true })))?.code === 'missing' && !!(await refused(alice.s('friend', { id: bob.id }))));
  const race = await Promise.all([alice.s('friend', { id: bob.id, on: true }), bob.s('friend', { id: alice.id, on: true })]);
  check('friend: both asking at once ends as friends', race.some((r) => r.relation === 1) && ids((await alice.s('home')).friends).join() === String(bob.id), JSON.stringify(race));
  await alice.s('friend', { id: bob.id, on: false });

  // ---- messages ---------------------------------------------------------------------------------------------------
  fresh();
  alice.forget(); bob.forget();
  const m1 = (await send(alice, bob, '  hi bob  ')).msg;
  check('chat.send: trimmed, the answer is the Msg', m1.text === 'hi bob' && m1.from === alice.id && m1.to === bob.id && typeof m1.id === 'number' && Math.abs(m1.at - Date.now()) < 5000 && Object.keys(m1).sort().join() === 'at,from,id,text,to', JSON.stringify(m1));
  const push = await bob.waitFor((e) => e.t === 'chat');
  check('chat push: the message and the sender as a Person, in real time', push?.msg.id === m1.id && push.msg.text === 'hi bob' && push.who.id === alice.id && push.who.name === 'alice' && Object.keys(push.who).sort().join() === personKeys, JSON.stringify(push));
  check('chat push: the tab that sent it doesn\'t get one', !alice.pushed('chat').length);
  const hb = await bob.s('home');
  check('home: a chat with its last message and the unread count', hb.chats.length === 1 && hb.chats[0].with.id === alice.id && hb.chats[0].last.id === m1.id && hb.chats[0].unread === 1, JSON.stringify(hb.chats));
  check('home: what you sent isn\'t unread on your side', (await alice.s('home')).chats[0].unread === 0);
  check('chat.read: clears the count and says how many', (await bob.s('chat.read', { id: alice.id })).read === 1 && (await bob.s('home')).chats[0].unread === 0 && (await bob.s('chat.read', { id: alice.id })).read === 0);
  fresh();
  const reply = (await send(bob, alice, 'hi alice')).msg;
  await alice.s('chat.read', { id: bob.id });
  fresh();
  const other2 = (await send(alice, dave, 'hi dave')).msg;
  const lasts = (await alice.s('home')).chats;
  check('home: each conversation\'s newest message, whoever wrote it, the newest chat first', lasts.length === 2 && lasts[0].last.id === other2.id && lasts[1].with.id === bob.id && lasts[1].last.id === reply.id && lasts[1].last.text === 'hi alice' && Object.keys(lasts[1].last).sort().join() === 'at,from,id,text,to', JSON.stringify(lasts.map((c) => c.last.text)));
  fresh();
  await send(alice, bob, 'not read yet');
  await send(erin, bob, 'nor this');
  const unreadOf = async (c, o) => (await c.s('home')).chats.find((x) => x.with.id === o.id)?.unread;
  check('chat.read: what you sent stays unread for them', (await alice.s('chat.read', { id: bob.id })).read === 0 && await unreadOf(bob, alice) === 1);
  check('chat.read: one chat at a time', (await bob.s('chat.read', { id: alice.id })).read === 1 && await unreadOf(bob, alice) === 0 && await unreadOf(bob, erin) === 1);
  await bob.s('chat.read', { id: erin.id });

  const textRefusals = [['', 'empty'], ['    ', 'spaces'], ['x'.repeat(301), '301 characters'], ['line\nbreak', 'a line break'], ['a\u0000b', 'NUL'], ['a\u0007b', 'a control character'], ['a‮b', 'right-to-left override'], ['a⁦b', 'a bidi isolate'],
    ['​', 'only a zero-width space'], ['⠀', 'only a blank braille letter'], ['\ud83d', 'a lone surrogate'], ['you fag', 'a slur'], ['f u c k', 'one spaced out'], ['sh!t', 'one in signs'], [12, 'a number'], [null, 'nothing'], [{ a: 1 }, 'an object']];
  const before = await conversationSize(alice, bob), through = [];
  for (const [t, what] of textRefusals) { fresh(); if (!(await refused(send(alice, bob, t)))) through.push(what); }
  check(`chat.send: refuses what it should (${textRefusals.length}), and stores none of it`, !through.length && await conversationSize(alice, bob) === before, through.join(', '));
  fresh();
  check('chat.send: 300 characters is fine, "grape" and "Scunthorpe" too', (await send(alice, bob, 'x'.repeat(300))).msg.text.length === 300 && !!(await send(alice, bob, 'grape soda in Scunthorpe')).msg);
  const slurs = ['nigger1', 'niggers1', 'niggerr', 'niggerlover', 'fagggot', 'faggots1', 'cuntface', 'hitlerwasright', 'neonazi', 'shitt', 'nigger', 'n1gger', 'n i g g e r', 'n.i.g.g.e.r', 'n!gger1', 'faggot', 'sh1t', 'sh!t', '$hit', 'shit!', 'ok,shit', 'shit1', 'fag2', 'niggaz', 'bullshit'];
  const words = ['snigger', 'sniggering', 'niggle', 'niggardly', 'Niger', 'grape', 'Scunthorpe', 'rapeseed', 'rapper', 'Ashkenazi', 'Shiite', 'shiitake', 'push it', 'push,it is fine', "rush.it's close", 'finish,its over', 'wish.it', 'push-it', 'cs2', 'ak47', 'de_dust2', 'state-of-the-art', 'hello, world'];
  const missed = slurs.filter((t) => !textProblem(t)), wronged = words.filter((t) => textProblem(t));
  check(`word filter: slurs with a digit, a repeat or something stuck on the end are refused (${slurs.length})`, !missed.length, missed.join(' '));
  check(`word filter: and normal sentences aren't, signs without spaces included (${words.length})`, !wronged.length, wronged.join(' | '));
  const self = await refused(send(alice, alice, 'me'));
  check('chat.send: not to yourself, or to nobody', !!self && (await refused(send(alice, 999999, 'hi')))?.code === 'missing');

  // Stored and sent exactly as typed, escaping is the game's job on each screen.
  fresh();
  const hostile = ['<img src=x onerror=alert(1)>', `"double" 'single' \`tick\``, '<script>alert(1)</script>&amp;', '👨‍👩‍👧‍👦 🇩🇪 😀', 'مرحبا שלום', 'w'.repeat(300), '$(rm -rf /); DROP TABLE messages; --', '\\u0000 %s %n'];
  const exact = [];
  bob.forget();
  for (const t of hostile) {
    fresh();
    const { msg } = await send(alice, bob, t);
    const got = await bob.waitFor((e) => e.t === 'chat' && e.msg.id === msg.id);
    const row = (await server.db.query('SELECT text FROM messages WHERE id = $1', [msg.id])).rows[0].text;
    if (msg.text !== t || got?.msg.text !== t || row !== t) exact.push(t);
  }
  const back = (await bob.s('chat.history', { id: alice.id })).msgs.map((m) => m.text);
  check('hostile text: stored, pushed and answered exactly as sent, nothing escaped on the server', !exact.length && hostile.every((t) => back.includes(t)), exact.join(' | '));

  // ---- two tabs ---------------------------------------------------------------------------------------------------
  const alice2 = await client(tok.alice), bob2 = await client(tok.bob);
  fresh();
  alice.forget(); bob.forget();
  const m2 = (await send(alice, bob, 'to all your tabs')).msg;
  const other = await alice2.waitFor((e) => e.t === 'chat' && e.msg.id === m2.id);
  check('two tabs: the sender\'s other tab gets it, with the receiver as `who`', other?.who.id === bob.id, JSON.stringify(other?.who));
  check('two tabs: both of the receiver\'s tabs get it, with the sender as `who`', (await bob.waitFor((e) => e.t === 'chat' && e.msg.id === m2.id))?.who.id === alice.id && (await bob2.waitFor((e) => e.t === 'chat' && e.msg.id === m2.id))?.who.id === alice.id);
  await wait(50);
  check('two tabs: the tab that sent it still gets none', !alice.pushed('chat').length);
  bob.forget(); bob2.forget();
  await bob.s('chat.read', { id: alice.id });
  check('two tabs: reading in one tells the other, not itself', !!(await bob2.waitFor((e) => e.t === 'friends')) && !bob.pushed('friends').length);
  alice.forget(); alice2.forget();
  await alice.s('profile.set', { bio: 'from tab one' });
  check('two tabs: a saved profile reaches the other tab', !!(await alice2.waitFor((e) => e.t === 'friends')));
  alice2.close(); bob2.close();

  // ---- a player who isn't there -----------------------------------------------------------------------------------
  fresh();
  const gm = (await send(alice, ghostId, 'are you there?')).msg;
  check('home: doesn\'t read an offline player\'s saved state for their level, nothing there shows one', (await alice.s('home')).chats.find((c) => c.with.id === ghostId)?.with.level === null);
  check('find: does, for its list', (await alice.s('find', { q: 'ghost' }))[0].level >= 1);
  const ghost = await client(tok.ghost);
  const gh = await ghost.s('home');
  check('offline: a message waits in home, unread', gh.chats.length === 1 && gh.chats[0].with.id === alice.id && gh.chats[0].last.id === gm.id && gh.chats[0].unread === 1);
  const gHist = await ghost.s('chat.history', { id: alice.id });
  check('offline: and in chat.history', gHist.msgs.length === 1 && gHist.msgs[0].text === 'are you there?' && gHist.more === false);
  ghost.close();
  const banned = await client(tok.ghost);
  await boss.admin('ban', { id: banned.id, reason: 'test ban' });
  await wait(50);
  fresh();
  const toBanned = await send(alice, banned.id, 'still stored');
  check('a banned player\'s connection is gone, and a message to them is stored all the same', banned.closed && !!toBanned.msg && await conversationSize(alice, banned) === 2);
  await boss.admin('unban', { id: banned.id });

  // ---- history pages ----------------------------------------------------------------------------------------------
  const page = async (c, o, b) => c.s('chat.history', { id: o.id, ...(b ? { before: b } : {}) });
  await server.db.query(`INSERT INTO messages (from_id, to_id, text, at) SELECT CASE WHEN g % 2 = 0 THEN $1::int ELSE $2::int END, CASE WHEN g % 2 = 0 THEN $2::int ELSE $1::int END, 'm' || g, g FROM generate_series(1, 120) g`, [carol.id, dave.id]);
  const p1 = await page(carol, dave), p2 = await page(carol, dave, p1.msgs[0].id), p3 = await page(carol, dave, p2.msgs[0].id);
  check('chat.history: 50 at a time, oldest first, the newest page first, `more` until the end', p1.msgs.length === 50 && p1.msgs[0].text === 'm71' && p1.msgs.at(-1).text === 'm120' && p1.more
    && p2.msgs[0].text === 'm21' && p2.msgs.at(-1).text === 'm70' && p2.more && p3.msgs.length === 20 && p3.msgs[0].text === 'm1' && !p3.more, `${p1.msgs[0].text} ${p2.msgs[0].text} ${p3.msgs.length}`);
  check('chat.history: the same from the other side', (await page(dave, carol)).msgs.at(-1).text === 'm120');
  check('chat.history: yours only: an empty one for two who never spoke, a bad `before` refused', !(await page(alice, erin)).msgs.length && !!(await refused(alice.s('chat.history', { id: bob.id, before: 'x' }))));

  // ---- the 200 message limit --------------------------------------------------------------------------------------
  await server.db.query(`INSERT INTO messages (from_id, to_id, text, at) SELECT $1::int, $2::int, 'old' || g, g FROM generate_series(1, 199) g`, [erin.id, dave.id]);
  await server.db.query(`INSERT INTO messages (from_id, to_id, text, at) VALUES ($1::int, $2::int, 'a neighbour', 1)`, [erin.id, carol.id]);
  fresh();
  await send(erin, dave, 'number 200');
  check('retention: 200 messages stay', await conversationSize(erin, dave) === 200);
  fresh();
  await send(dave, erin, 'number 201');
  fresh();
  await send(erin, dave, 'number 202');
  const kept = (await server.db.query('SELECT text FROM messages WHERE from_id IN ($1, $2) AND to_id IN ($1, $2) ORDER BY id', [erin.id, dave.id])).rows.map((r) => r.text);
  check('retention: past that the oldest go, in both directions, when writing', kept.length === 200 && kept[0] === 'old3' && kept.at(-1) === 'number 202' && kept.includes('number 201'), `${kept.length} ${kept[0]}`);
  check('retention: other conversations aren\'t touched', await conversationSize(erin, carol) === 1 && await conversationSize(carol, dave) === 120);

  // ---- who can message you ----------------------------------------------------------------------------------------
  await carol.s('profile.set', { dms: 'friends' });
  check('friends only: the setting shows in your home', (await carol.s('home')).settings.dms === 'friends');
  check('friends only: it isn\'t on your profile for others to read', !('dms' in (await erin.s('profile', { id: carol.id }))) && !JSON.stringify(await erin.s('profile', { id: carol.id })).includes('"friends":"'));
  fresh();
  const friendsOnly = await refused(send(erin, carol, 'hello'));
  check('friends only: a stranger is refused, and nothing is stored', friendsOnly?.code === 'dms' && await conversationSize(erin, carol) === 1, friendsOnly?.message);
  await erin.s('friend', { id: carol.id, on: true });
  check('friends only: a request sent isn\'t enough', (await refused(send(erin, carol, 'hello')))?.code === 'dms');
  await carol.s('friend', { id: erin.id, on: true });
  fresh();
  check('friends only: friends get through, either way', !!(await send(erin, carol, 'hello')).msg && !!(await send(carol, erin, 'hi')).msg);
  await carol.s('friend', { id: erin.id, on: false });
  fresh();
  check('friends only: and not after the friendship ends', (await refused(send(erin, carol, 'hello')))?.code === 'dms');
  check('friends only: it limits who writes to you, not who you write to', !!(await send(carol, dave, 'friends-only players can still write')).msg);
  await carol.s('profile.set', { dms: 'everyone' });
  fresh();
  check('everyone: back to anyone', !!(await send(erin, carol, 'hello again')).msg);

  // ---- blocks -----------------------------------------------------------------------------------------------------
  const frank = await client(tok.frank);
  await alice.s('friend', { id: frank.id, on: true });
  await frank.s('friend', { id: alice.id, on: true });
  fresh();
  await send(frank, alice, 'before the block');
  await alice.s('chat.read', { id: frank.id });
  alice.forget(); frank.forget();
  await alice.s('block', { id: frank.id, on: true });
  check('block: ends the friendship, on both sides', !(await alice.s('home')).friends.length && !(await frank.s('home')).friends.length);
  check('block: tells the blocked player only what removing a friend would: lists changed', !!(await frank.waitFor((e) => e.t === 'friends')) && frank.events.every((e) => e.t === 'friends' || e.t === 'players'), JSON.stringify(frank.events.map((e) => e.t)));
  const ah = await alice.s('home');
  check('block: on your Blocked list, the chat off your list', ids(ah.blocked).join() === String(frank.id) && !ah.chats.some((c) => c.with.id === frank.id));
  check('block: not on theirs', !(await frank.s('home')).blocked.length && (await frank.s('home')).chats.some((c) => c.with.id === alice.id));

  fresh();
  alice.forget();
  const fromBlocked = await refused(send(frank, alice, 'can you see this?'));
  const size = await conversationSize(alice, frank);
  await wait(50);
  check('block: nothing arrives from them, nothing is stored', !!fromBlocked && !alice.pushed('chat').length && size === 1);
  // A friends-only player, from a stranger: the same refusal but the name.
  await dave.s('profile.set', { dms: 'friends' });
  fresh();
  const fromStranger = await refused(send(frank, dave, 'hi'));
  await dave.s('profile.set', { dms: 'everyone' });
  check('block: the refusal doesn\'t reveal it: the same words and code as a friends-only player\'s',
    fromBlocked.code === fromStranger.code && fromBlocked.message.replace('alice', 'X') === fromStranger.message.replace('dave', 'X') && !/block/i.test(fromBlocked.message), `${fromBlocked.message} / ${fromStranger.message}`);
  fresh();
  const toBlocked = await refused(send(alice, frank, 'hello?'));
  check('block: you can\'t message them either', /Unblock/.test(toBlocked?.message) && await conversationSize(alice, frank) === 1, toBlocked?.message);
  check('block: you can\'t friend them while they\'re blocked', /Unblock/.test((await refused(alice.s('friend', { id: frank.id, on: true })))?.message));

  alice.forget(); frank.forget();
  const ask = await frank.s('friend', { id: alice.id, on: true });
  await wait(50);
  const ah2 = await alice.s('home');
  check('block: they can\'t friend you: it never arrives, no push and no request', !ah2.requests.length && !alice.pushed('friends').length && (await alice.s('profile', { id: frank.id })).relation === 0);
  check('block: and it looks sent to them, as if ignored', ask.relation === 3 && ids((await frank.s('home')).sent).join() === String(alice.id) && (await frank.s('profile', { id: alice.id })).relation === 3);

  const view = await frank.s('profile', { id: alice.id });
  const plain = await erin.s('profile', { id: alice.id });
  const strip = ({ relation, ...p }) => JSON.stringify(p);
  check('block: their view of your profile is anyone\'s', strip(view) === strip(plain) && view.blockedByMe === false && !JSON.stringify(view).includes('blocked":true'));
  check('block: you see blockedByMe, they find you as anyone would', (await alice.s('profile', { id: frank.id })).blockedByMe === true && ids(await frank.s('find', { q: 'alice' })).includes(alice.id));
  check('block: blocked twice is one block, and not yourself or nobody', (await alice.s('block', { id: frank.id, on: true })).blockedByMe === true && await count('SELECT count(*)::int AS n FROM blocks') === 1
    && !!(await refused(alice.s('block', { id: alice.id, on: true }))) && (await refused(alice.s('block', { id: 999999, on: true })))?.code === 'missing');

  // Trade offers are something received too.
  const hiddenOffer = await frank.rpc('trade', 'offer', { to: 'alice', get: { uids: [uids[3]] } });
  await wait(50);
  const noticed = alice.events.filter((e) => e.t === 'notice' || e.t === 'trades').filter((e) => e.t === 'notice' || e.trades.some((t) => t.id === hiddenOffer.id));
  check('block: a trade offer from them never arrives: no notice, not on your list, your items not held by it', !noticed.length && !(await server.srv.trades.list(alice.id)).some((t) => t.id === hiddenOffer.id) && !server.srv.trades.asked(alice.id).has(uids[3]), JSON.stringify(noticed.map((e) => e.t)));
  check('block: and to them it\'s an open offer, as if ignored, that they can cancel', (await server.srv.trades.list(frank.id)).find((t) => t.id === hiddenOffer.id)?.status === 'open' && !('hidden' in (await server.srv.trades.list(frank.id))[0]));
  const answers = [await refused(alice.rpc('trade', 'accept', { id: hiddenOffer.id })), await refused(alice.rpc('trade', 'decline', { id: hiddenOffer.id }))];
  check('block: you can\'t accept or decline what you never got, even with its id', answers.every((e) => /no longer open/.test(e?.message)) && (await server.srv.trades.list(frank.id)).find((t) => t.id === hiddenOffer.id)?.status === 'open', answers.map((e) => e?.message).join(' / '));
  check('block: and you can\'t send them one', /Unblock/.test((await refused(alice.rpc('trade', 'offer', { to: 'frank', give: { money: 1 } })))?.message));
  await frank.rpc('trade', 'cancel', { id: hiddenOffer.id });
  await giveItems(frank, [aSkin(9)]);
  const friendsTrade = await erin.rpc('trade', 'offer', { to: 'bob', give: { money: 1 } });
  check('trade offers between anyone else are as they were', (await server.srv.trades.list(bob.id)).some((t) => t.id === friendsTrade.id) && !!(await bob.waitFor((e) => e.t === 'notice')));
  await erin.rpc('trade', 'cancel', { id: friendsTrade.id });

  // What's written on an offer reaches the other player, so it's a message: the same setting, filter and refusal.
  const offerWith = (c, to, msg) => c.rpc('trade', 'offer', { to, get: { money: 1 }, ...(msg == null ? {} : { msg }) });
  await carol.s('profile.set', { dms: 'friends' });
  fresh();
  const toFriendsOnly = await refused(offerWith(erin, 'carol', 'buy my stuff')), chatRefusal = await refused(send(erin, carol, 'buy my stuff'));
  check('offer message: a stranger\'s to a friends-only player is refused, in chat\'s words', toFriendsOnly?.code === 'dms' && toFriendsOnly.message === chatRefusal?.message && !server.srv.trades.asked(carol.id).size, toFriendsOnly?.message);
  const plainOffer = await offerWith(erin, 'carol');
  check('offer message: without one the offer still goes', (await server.srv.trades.list(carol.id)).some((t) => t.id === plainOffer.id));
  await erin.rpc('trade', 'cancel', { id: plainOffer.id });
  const fromBlockedOffer = await refused(offerWith(frank, 'alice', 'buy my stuff'));
  check('offer message: one to someone who blocked you is refused the same way: nothing tells the two apart', fromBlockedOffer?.code === toFriendsOnly?.code && fromBlockedOffer?.message.replace('alice', 'X') === toFriendsOnly?.message.replace('carol', 'X'), fromBlockedOffer?.message);
  await erin.s('friend', { id: carol.id, on: true });
  await carol.s('friend', { id: erin.id, on: true });
  const palOffer = await offerWith(erin, 'carol', 'for a friend');
  check('offer message: a friend\'s arrives', (await server.srv.trades.list(carol.id)).find((t) => t.id === palOffer.id)?.msg === 'for a friend');
  await erin.rpc('trade', 'cancel', { id: palOffer.id });
  await carol.s('friend', { id: erin.id, on: false });
  await carol.s('profile.set', { dms: 'everyone' });
  const badNotes = ['you fag', 'nigger1', 'a\u202eb', 'a\u0007b', 'x'.repeat(141)], through2 = [];
  for (const t of badNotes) if (!(await refused(offerWith(erin, 'bob', t)))) through2.push(t);
  check(`offer message: the filter and the characters a message can't hold (${badNotes.length})`, !through2.length, through2.join(' '));
  const fineNote = await offerWith(erin, 'bob', '  fair <b>price</b>  ');
  check('offer message: < and > still go, and a fine one is kept', (await server.srv.trades.list(bob.id)).find((t) => t.id === fineNote.id)?.msg === 'fair bprice/b');
  await erin.rpc('trade', 'cancel', { id: fineNote.id });
  fresh();
  const offers = await tries(21, async () => { const o = await offerWith(erin, 'bob'); await erin.rpc('trade', 'cancel', { id: o.id }); });
  check('rate: 20 trade offers a minute, cancelled or not, then a plain refusal', offers.ok === 20 && offers.stop?.code === 'rate' && /20 trade offers a minute/.test(offers.stop.message), `${offers.ok}: ${offers.stop?.message}`);
  passTime(61000);
  const nextOffer = await offerWith(erin, 'bob');
  check('rate: a minute later it\'s open again', !!nextOffer.id);
  await erin.rpc('trade', 'cancel', { id: nextOffer.id });
  server.srv.social.hits.set(`offer:${erin.id}`, Array.from({ length: 100 }, () => server.srv.social.now() - 120000));
  check('rate: and 100 an hour', (await refused(offerWith(erin, 'bob')))?.code === 'rate');

  alice.forget(); frank.forget();
  await alice.s('block', { id: frank.id, on: false });
  check('unblock: off the list, and what they asked for meanwhile doesn\'t turn up', !(await alice.s('home')).blocked.length && !(await alice.s('home')).requests.length && !(await frank.s('home')).sent.length);
  fresh();
  check('unblock: messages work both ways again, the old chat is back', !!(await send(frank, alice, 'back')).msg && !!(await send(alice, frank, 'hello')).msg && (await alice.s('home')).chats.some((c) => c.with.id === frank.id));
  check('unblock: and friends can be asked', (await alice.s('friend', { id: frank.id, on: true })).relation === 3);
  await alice.s('friend', { id: frank.id, on: false });

  await alice.s('block', { id: frank.id, on: true });
  await frank.s('block', { id: alice.id, on: true });
  fresh();
  const both = [await refused(send(alice, frank, 'x')), await refused(send(frank, alice, 'x'))];
  check('blocks both ways: each only ever hears of their own', both.every((e) => /Unblock/.test(e?.message)));
  await frank.s('block', { id: alice.id, on: false });
  fresh();
  check('blocks both ways: the other one still stands', (await refused(send(frank, alice, 'x')))?.code === 'dms' && /Unblock/.test((await refused(send(alice, frank, 'x')))?.message));
  await alice.s('block', { id: frank.id, on: false });

  // ---- rate limits ------------------------------------------------------------------------------------------------
  fresh();
  const burst = [];
  for (let i = 0; i < 5; i++) burst.push((await send(dave, erin, `burst ${i}`)).msg);
  const sixth = await refused(send(dave, erin, 'one too many'));
  check('rate: 5 messages in 5 seconds, then a plain refusal, and it isn\'t stored', burst.length === 5 && sixth?.code === 'rate' && /5 messages in 5 seconds/.test(sixth.message) && !(await dave.s('chat.history', { id: erin.id })).msgs.some((m) => m.text === 'one too many'), sixth?.message);
  check('rate: per player, not per conversation', (await refused(send(dave, carol, 'another chat')))?.code === 'rate');
  const dave2 = await client(tok.dave);
  check('rate: and not per tab', (await refused(send(dave2, erin, 'from a second tab')))?.code === 'rate');
  dave2.close();
  passTime(5100);
  check('rate: 5 seconds later it\'s open again', !!(await send(dave, erin, 'and again')).msg);
  // (5 in 5 seconds is already 60 a minute at most: trying twice a second for a minute shows the total, and the second rule's
  // own refusal needs its record set by hand, 60 messages each older than the 5 seconds)
  fresh();
  let sent = 0;
  for (let i = 0; i < 120; i++) { passTime(500); if (!(await refused(send(dave, erin, `steady ${i}`)))) sent++; }
  check('rate: however they\'re spread, at most 60 in a minute', sent >= 55 && sent <= 60, `${sent} of 120`);
  fresh();
  const minuteAgo = server.srv.social.now() - 50000;
  server.srv.social.hits.set(`chat:${dave.id}`, Array.from({ length: 60 }, (_, i) => minuteAgo + i));
  const sixtyFirst = await refused(send(dave, erin, 'over the minute'));
  check('rate: 60 a minute, then a plain refusal', sixtyFirst?.code === 'rate' && /60 messages a minute/.test(sixtyFirst.message), sixtyFirst?.message);
  passTime(61000);
  check('rate: a minute later it\'s open again', !!(await send(dave, erin, 'after the minute')).msg);
  fresh();
  const someone = (await server.db.query(`INSERT INTO users (name, name_lc, pass, state, created, last_seen) SELECT 'asked' || g, 'asked' || g, 'x', '{}'::jsonb, 1, 1 FROM generate_series(1, 31) g RETURNING id`)).rows.map((r) => r.id);
  let asked = 0, askStop = null;
  for (const id of someone) { const e = await refused(erin.s('friend', { id, on: true })); if (e) { askStop = e; break; } asked++; }
  check('rate: 30 friend requests an hour, then a plain refusal', asked === 30 && askStop?.code === 'rate' && /30 an hour/.test(askStop.message), `${asked}: ${askStop?.message}`);
  await carol.s('friend', { id: erin.id, on: true });
  check('rate: accepting isn\'t asking', (await erin.s('friend', { id: carol.id, on: true })).relation === 1);
  await erin.s('friend', { id: carol.id, on: false });
  passTime(3600000 + 1000);
  check('rate: an hour later it\'s open again', (await erin.s('friend', { id: someone[30], on: true })).relation === 3);
  await server.db.query("DELETE FROM users WHERE name_lc LIKE 'asked%'");
  const social = server.srv.social, staleRecord = social.hits.has(`chat:${dave.id}`);
  social.sweep();
  check('rate: the record of attempts is cleared out, what\'s recent stays', staleRecord && !social.hits.has(`chat:${dave.id}`) && social.hits.has(`friend:${erin.id}`), [...social.hits.keys()].join());

  // Going through every player: what's only read, and blocks.
  fresh();
  const homes = await tries(31, () => dave.raw('home'));
  check('rate: home, 30 in 10 seconds, then a plain refusal', homes.ok === 30 && homes.stop?.code === 'rate' && /Slow down/.test(homes.stop.message), `${homes.ok}: ${homes.stop?.message}`);
  passTime(10100);
  check('rate: 10 seconds later it\'s open again', !!(await dave.raw('home')).me);
  fresh();
  const finds = await tries(11, () => dave.raw('find', { q: 'a' }));
  check('rate: find, 10 in 5 seconds', finds.ok === 10 && finds.stop?.code === 'rate', `${finds.ok}: ${finds.stop?.message}`);
  fresh();
  social.hits.set(`find:${dave.id}`, Array.from({ length: 60 }, () => social.now() - 30000));
  check('rate: and 60 a minute', /60 searches a minute/.test((await refused(dave.raw('find', { q: 'a' })))?.message));
  fresh();
  const views = await tries(21, () => dave.raw('profile', { id: erin.id }));
  check('rate: profile, 20 in 10 seconds', views.ok === 20 && views.stop?.code === 'rate', `${views.ok}: ${views.stop?.message}`);
  fresh();
  await server.store.withUser(erin.id, async (e) => { e.st.inv.push({ uid: 'erin-unit', t: 'unit', id: 'storage-unit', at: 1 }); server.store.markDirty(e); });
  const peeks = await tries(21, () => dave.raw('unit', { id: erin.id, uid: 'erin-unit' }));
  check('rate: opening Storage Units, 20 in 10 seconds', peeks.ok === 20 && peeks.stop?.code === 'rate', `${peeks.ok}: ${peeks.stop?.message}`);
  await server.store.withUser(erin.id, async (e) => { e.st.inv = e.st.inv.filter((i) => i.uid !== 'erin-unit'); server.store.markDirty(e); });
  fresh();
  social.hits.set(`profile:${dave.id}`, Array.from({ length: 120 }, () => social.now() - 30000));
  check('rate: and 120 a minute', /120 profiles a minute/.test((await refused(dave.raw('profile', { id: erin.id })))?.message));
  check('rate: per player: someone else can still look', !!(await erin.raw('profile', { id: dave.id })).name);
  fresh();
  const walled = (await server.db.query(`INSERT INTO users (name, name_lc, pass, state, created, last_seen) SELECT 'walled' || g, 'walled' || g, 'x', '{}'::jsonb, 1, 1 FROM generate_series(1, 502) g RETURNING id`)).rows.map((r) => r.id);
  const blocking = await tries(31, (i) => erin.s('block', { id: walled[i], on: true }));
  check('rate: 30 blocks an hour, then a plain refusal, and nothing more is stored', blocking.ok === 30 && blocking.stop?.code === 'rate' && /30 an hour/.test(blocking.stop.message) && await count('SELECT count(*)::int AS n FROM blocks WHERE user_id = $1', [erin.id]) === 30, `${blocking.ok}: ${blocking.stop?.message}`);
  check('rate: unblocking isn\'t limited', (await erin.s('block', { id: walled[0], on: false })).blockedByMe === false);
  fresh();
  await server.db.query('INSERT INTO blocks (user_id, blocked_id, at) SELECT $1::int, id, 1 FROM unnest($2::int[]) AS id ON CONFLICT DO NOTHING', [erin.id, walled.slice(0, 500)]);
  const walledIn = await refused(erin.s('block', { id: walled[500], on: true }));
  check('block: at most 500 on your list, and it says so', /up to 500/.test(walledIn?.message) && await count('SELECT count(*)::int AS n FROM blocks WHERE user_id = $1', [erin.id]) === 500, walledIn?.message);
  check('block: blocking someone already on a full list is no change', (await erin.s('block', { id: walled[0], on: true })).blockedByMe === true);
  const fullHome = await erin.s('home');
  check('home: a full Blocked list comes back, with no offline player\'s saved state read for it', fullHome.blocked.length === 500 && fullHome.blocked.every((p) => p.level === null), `${fullHome.blocked.length}`);
  await server.db.query("DELETE FROM users WHERE name_lc LIKE 'walled%'");

  // ---- reports ----------------------------------------------------------------------------------------------------
  await server.db.query(`INSERT INTO messages (from_id, to_id, text, at) SELECT CASE WHEN g % 2 = 0 THEN $1::int ELSE $2::int END, CASE WHEN g % 2 = 0 THEN $2::int ELSE $1::int END, 'said ' || g, g FROM generate_series(1, 40) g`, [bob.id, frank.id]);
  modLog.length = 0;
  const rep = await bob.s('report', { id: frank.id, reason: 'harassment', text: 'he <b>won\'t</b> stop\n‮please' });
  await wait(30);
  const { rows: [saved1] } = await server.db.query('SELECT * FROM reports WHERE id = $1', [rep.id]);
  const copy = typeof saved1.messages === 'string' ? JSON.parse(saved1.messages) : saved1.messages;
  check('report: saves the last 30 messages between you, oldest first', copy.length === 30 && copy[0].text === 'said 11' && copy.at(-1).text === 'said 40' && Object.keys(copy[0]).sort().join() === 'at,from,id,text,to', `${copy.length} ${copy[0]?.text}`);
  check('report: the reason and text, without what can\'t be shown', saved1.reason === 'harassment' && saved1.text === "he <b>won't</b> stop please" && saved1.from_id === bob.id && saved1.about_id === frank.id && saved1.closed_at == null, JSON.stringify(saved1.text));
  const logged = JSON.stringify(modLog[0] || {});
  check('report: tells the mod log who it\'s about and the reason, and not who sent it, what they wrote or the messages', modLog.length === 1 && modLog[0].title === 'Player reported' && logged.includes('harassment') && logged.includes('frank') && logged.includes('#' + rep.id) && !/bob|stop|said \d/.test(logged), logged);
  check('report: not told to the player reported', !frank.events.some((e) => JSON.stringify(e).includes('report')));
  await server.db.query('DELETE FROM messages WHERE from_id IN ($1, $2) AND to_id IN ($1, $2)', [bob.id, frank.id]);
  check('report: not yourself, nobody, or without a reason', !!(await refused(bob.s('report', { id: bob.id, reason: 'x' }))) && (await refused(bob.s('report', { id: 999999, reason: 'x' })))?.code === 'missing' && !!(await refused(bob.s('report', { id: frank.id }))) && !!(await refused(bob.s('report', { id: frank.id, reason: 'x'.repeat(81) }))));
  await carol.s('profile.set', { bio: 'what the filter let through' });
  const noChat = await bob.s('report', { id: carol.id, reason: 'bad profile' });
  const onlyBio = (await boss.admin('reports')).rows.find((r) => r.id === noChat.id);
  check('report: works from a profile, with no messages between you', onlyBio?.messages.length === 0);
  check('report: saves their summary as it stood', onlyBio.bio === 'what the filter let through' && onlyBio.about.bio === 'what the filter let through', JSON.stringify(onlyBio));
  await carol.s('profile.set', { bio: 'nothing to see here' });
  const changedBio = (await boss.admin('reports')).rows.find((r) => r.id === noChat.id);
  check('report: and that copy stays when they change it, next to what it says now', changedBio.bio === 'what the filter let through' && changedBio.about.bio === 'nothing to see here');
  await boss.admin('report.close', { id: noChat.id });
  fresh();
  let reports = 0, repStop = null;
  for (let i = 0; i < 12 && !repStop; i++) { const e = await refused(dave.s('report', { id: erin.id, reason: 'spam' })); if (e) repStop = e; else reports++; }
  check('report: at most 10 an hour (each posts to the mod log)', reports === 10 && repStop?.code === 'rate', `${reports} ${repStop?.message}`);
  await server.db.query('DELETE FROM reports WHERE from_id = $1', [dave.id]);

  // Staff rights.
  const playerSees = [await refused(alice.admin('reports')), await refused(alice.admin('report.close', { id: rep.id }))];
  check('reports: a player is refused', playerSees.every((e) => e?.code === 'perm'));
  server.admin.levels.set(moddy.id, { level: 1, at: Date.now() });
  const list1 = await moddy.admin('reports');
  const r1 = list1.rows.find((r) => r.id === rep.id);
  check('reports: a moderator sees it, with the saved messages and both names', list1.open === 1 && list1.total === 1 && r1?.from.name === 'bob' && r1.about.name === 'frank' && r1.reason === 'harassment' && r1.messages.length === 30 && r1.closedAt === null && typeof r1.at === 'number', JSON.stringify({ ...r1, messages: r1?.messages.length }));
  check('reports: the copy outlives the conversation', r1.messages.at(-1).text === 'said 40' && await conversationSize(bob, frank) === 0);
  server.admin.levels.set(frank.id, { level: 1, at: Date.now() });
  check('reports: staff can\'t close one about themselves', (await refused(frank.admin('report.close', { id: rep.id })))?.code === 'perm');
  const ownList = await frank.admin('reports');
  check('reports: below admin one about yourself isn\'t shown, in the rows or the counts: it names the player who sent it', !ownList.rows.some((r) => r.id === rep.id) && ownList.open === 0 && ownList.total === 0 && list1.open === 1, JSON.stringify({ open: ownList.open, total: ownList.total }));
  const ownReads = JSON.stringify([await frank.admin('audit', { q: 'frank' }), await frank.admin('overview'), await frank.admin('player', { id: frank.id })]);
  check('reports: and no other screen of theirs has it: the audit log, the dashboard or their own player page', !ownReads.includes('"action":"report"') && !ownReads.includes(String(rep.id) + ',"reason"'), ownReads.slice(0, 200));
  check('reports: the panel is told how the player reported ranks', (await moddy.admin('reports')).rows.find((r) => r.id === rep.id)?.about.staff === 1);
  check('reports: a moderator can\'t close one about staff of their own level', (await refused(moddy.admin('report.close', { id: rep.id })))?.code === 'perm' && (await moddy.admin('reports')).open === 1);
  const aboutBoss = await bob.s('report', { id: boss.id, reason: 'abusing his powers' });
  check('reports: or about an admin', (await refused(moddy.admin('report.close', { id: aboutBoss.id })))?.code === 'perm');
  const bossList = await boss.admin('reports');
  check('reports: an admin still sees one about themselves, and can\'t close it', bossList.rows.find((r) => r.id === aboutBoss.id)?.from.name === 'bob' && (await refused(boss.admin('report.close', { id: aboutBoss.id })))?.code === 'perm');
  await server.db.query('DELETE FROM reports WHERE id = $1', [aboutBoss.id]);
  server.admin.levels.delete(frank.id);
  modLog.length = 0;
  await moddy.admin('report.close', { id: rep.id });
  await wait(30);
  const list2 = await moddy.admin('reports');
  const closed = (await moddy.admin('reports', { closed: true })).rows.find((r) => r.id === rep.id);
  check('report.close: it leaves the open list, and the closed one has who and when', !list2.rows.some((r) => r.id === rep.id) && list2.open === 0 && closed?.closedBy === 'moddy' && Math.abs(closed.closedAt - Date.now()) < 5000);
  const audit = (await server.db.query("SELECT * FROM audit WHERE action = 'report.close' ORDER BY id DESC LIMIT 1")).rows[0];
  const audited = (await server.db.query("SELECT * FROM audit WHERE action = 'report'")).rows;
  check('report.close: audited like other staff actions, and in the mod log', audit?.actor === 'moddy' && audit.target_id === frank.id && audited.length === 0 && modLog[0]?.title === 'Report closed', JSON.stringify(audit));
  check('report.close: closing twice is refused, an unknown one too', /already closed/.test((await refused(moddy.admin('report.close', { id: rep.id })))?.message) && (await refused(moddy.admin('report.close', { id: 999999 })))?.code === 'missing' && !!(await refused(moddy.admin('report.close', {}))));

  // A summary the filter let through comes off, by staff.
  const cleanBio = () => server.db.query("SELECT profile->>'bio' AS bio FROM users WHERE id = $1", [carol.id]).then((r) => r.rows[0].bio);
  await carol.s('profile.set', { bio: 'what the filter let through' });
  const clearRefusals = [await refused(alice.admin('bio.clear', { id: carol.id })), await refused(moddy.admin('bio.clear', { id: boss.id }))];
  check('bio.clear: not by a player, or a moderator on an admin, and the summary stays', clearRefusals.every((e) => e?.code === 'perm') && await cleanBio() === 'what the filter let through', clearRefusals.map((e) => e?.message).join(' / '));
  modLog.length = 0;
  carol.forget();
  const carolBefore = await carol.s('profile', { id: carol.id });
  await moddy.admin('bio.clear', { id: carol.id });
  await wait(30);
  const carolAfter = await carol.s('profile', { id: carol.id }), bioAudit = (await server.db.query("SELECT * FROM audit WHERE action = 'bio.clear' ORDER BY id DESC LIMIT 1")).rows[0];
  check('bio.clear: a moderator takes it off, and only that changes', carolAfter.bio === '' && (await bob.s('profile', { id: carol.id })).bio === '' && carolAfter.avatar === carolBefore.avatar && carolAfter.country === carolBefore.country && !!(await carol.waitFor((e) => e.t === 'friends')));
  const bioDetail = typeof bioAudit?.detail === 'string' ? JSON.parse(bioAudit.detail) : bioAudit?.detail;
  check('bio.clear: audited with what it said, and in the mod log', bioAudit?.actor === 'moddy' && bioAudit.target_id === carol.id && bioDetail?.bio === 'what the filter let through' && modLog[0]?.title === 'Summary cleared', JSON.stringify(bioAudit));
  check('bio.clear: nothing to clear is refused', /no summary/.test((await refused(moddy.admin('bio.clear', { id: carol.id })))?.message));
  check('bio.clear: a closed report keeps its copy', (await moddy.admin('reports', { closed: true })).rows.find((r) => r.id === noChat.id)?.bio === 'what the filter let through');

  // Private means private.
  const methods = Object.keys(server.admin.methods);
  check('no staff request reads messages: reports are the only thing added to the panel', methods.includes('reports') && methods.includes('report.close') && !methods.some((m) => /chat|message|dm/i.test(m)));
  check('nor does any other file ask for the messages table but social.mjs', ['admin', 'index', 'trade', 'live', 'discord', 'accounts', 'store'].every((f) => !/\b(FROM|INTO|UPDATE) messages\b/.test(fs.readFileSync(new URL(`./${f}.mjs`, import.meta.url), 'utf8'))));
  await bob.s('friend', { id: dave.id, on: true });
  await dave.s('friend', { id: bob.id, on: true });
  // (alts: accounts on the same network, which here is all of them, and has nothing to do with friends)
  const { alts, ...panel } = await boss.admin('player', { id: bob.id }), panelPage = JSON.stringify(panel);
  check('a player panel page has no messages or friends in it', ids((await bob.s('home')).friends).includes(dave.id) && (await bob.s('home')).chats.length > 0 && !panelPage.includes('hi bob') && !panelPage.includes('hi alice') && !panelPage.includes('dave'), (panelPage.match(/.{80}(dave|hi bob|hi alice).{60}/) || [''])[0]);
  await bob.s('friend', { id: dave.id, on: false });

  // The server's address stays out of it.
  const source = fs.readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');
  check('the server\'s address isn\'t in the module', !/https?:\/\/|onrender|cs2casesim/.test(source));

  // ---- a 1.1.0 game -----------------------------------------------------------------------------------------------
  // Exactly what src/js/net/online.js' handle() takes in that version: anything else falls through its switch.
  const OLD = new Set(['res', 'delta', 'lobbies', 'players', 'trades', 'gamble.result', 'notice', 'market', 'account', 'admin.msg', 'update']);
  const welcomeKeys = 'account,lobbies,market,motd,players,pricedAt,serverTime,state,t,trades,user';
  const old = await new Promise((resolve, reject) => {
    const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
    const c = { ws, unknown: [], closed: false, handled: 0 };
    ws.on('close', () => { c.closed = true; });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: tok.carol, data: D.generatedAt, v: 1, app: '1.1.0' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.welcome = m; resolve(c); return; }
      if (m.t === 'fatal') { reject(new Error(m.error)); return; }
      if (OLD.has(m.t)) c.handled++; else c.unknown.push(m.t);
      if (m.t === 'res') c.last = m;
    });
  });
  check('1.1.0: let in on the same protocol, its welcome unchanged', Object.keys(old.welcome).sort().join() === welcomeKeys, Object.keys(old.welcome).sort().join());
  fresh();
  await send(erin, carol, 'to an old game');
  await erin.s('friend', { id: carol.id, on: true });
  await wait(100);
  check('1.1.0: the new pushes are the only unknown ones, and they go past it', old.unknown.length >= 2 && old.unknown.every((t) => t === 'chat' || t === 'friends') && !old.closed, old.unknown.join());
  old.ws.send(JSON.stringify({ t: 'rpc', id: 1, ns: 'act', m: 'nothing.here', args: {} }));
  await wait(100);
  check('1.1.0: and it keeps working', old.last?.id === 1 && !old.closed);
  const players = alice.events.filter((e) => e.t === 'players').at(-1);
  check('presence stays the `players` broadcast, its rows as they were', !players || players.players.every((p) => Object.keys(p).sort().join() === 'name,online,worth'));
  old.ws.close();

  // ---- a staff rename ---------------------------------------------------------------------------------------------
  const renamee = await client(await register('oldname'));
  await bob.s('friend', { id: renamee.id, on: true });
  await renamee.s('friend', { id: bob.id, on: true });
  fresh();
  await send(renamee, dave, 'only a chat with this one');
  await erin.s('block', { id: renamee.id, on: true });
  for (const c of [bob, dave, erin, alice, renamee]) c.forget();
  await boss.admin('rename', { id: renamee.id, name: 'newname' });
  const told = await Promise.all([bob, dave, erin, renamee].map((c) => c.waitFor((e) => e.t === 'friends')));
  check('rename: tells the player, and everyone with them as a friend, in a chat or blocked', told.every(Boolean), told.map((x) => !!x).join());
  await wait(50);
  check('rename: and nobody else', !alice.pushed('friends').length);
  const seenAs = (await bob.s('home')).friends.find((p) => p.id === renamee.id)?.name;
  check('rename: their lists have the new name', seenAs === 'newname' && (await dave.s('home')).chats.find((c) => c.with.id === renamee.id)?.with.name === 'newname' && (await erin.s('home')).blocked.find((p) => p.id === renamee.id)?.name === 'newname', seenAs);
  check('rename: and who\'s online has it too, where games look friends up by name', (await bob.waitFor((e) => e.t === 'players' && e.players.some((p) => p.name === 'newname')))?.players.every((p) => p.name !== 'oldname'));
  await erin.s('block', { id: renamee.id, on: false });
  await bob.s('friend', { id: renamee.id, on: false });
  renamee.close();

  // ---- the item database's float records (db.floats) -----------------------------------------------------------------
  {
    const DB = await import('../src/js/engine/database.js');
    const { ownedItems } = await import('../src/js/engine/storage.js');
    const { FLOATS_MS } = await import('./dbfloats.mjs');
    const def = Object.values(D.skins).find((s) => !s.v && s.stt), vanilla = Object.values(D.skins).find((s) => s.v);
    const mk = (fl, x = {}) => makeSkinItem(def, { src: 'test', fl, stt: false, ...x });
    // (far past every float the other tests' skins rolled: the ends of the lists are these)
    const aLow = mk(1e-7), aStored = { ...mk(5e-8), su: 'unit-x', sat: Date.now() }, aHigh = mk(0.9999998, { stt: true });
    const bSt = mk(2e-7, { stt: true }), bSv = mk(3e-7, { sv: true }), bHigh = mk(0.9999999), bVanilla = makeSkinItem(vanilla, { src: 'test' });
    const sticker = { uid: 'stk-floats', t: 'sticker', id: Object.keys(D.stickers)[0], at: Date.now(), src: 'test' };
    await giveItems(alice, [aLow, aHigh]);
    await server.store.withUser(alice.id, async (e) => { e.st.stored = [...(e.st.stored || []), aStored]; server.store.markDirty(e); });
    await giveItems(bob, [bSt, bSv, bHigh, bVanilla, sticker]);
    await server.store.flush();
    const F = server.srv.floats;
    F.cache = null; // (the empty server's lists, from the start)
    F.now = () => clock;
    // What the lists should be: the engine's floatRecords over every player's inventory and Storage Units.
    const everyone = (await server.db.query('SELECT id, state FROM users')).rows.flatMap((u) => ownedItems(typeof u.state === 'string' ? JSON.parse(u.state) : u.state).map((item) => ({ id: u.id, item })));
    const want = (o) => DB.floatRecords(everyone, { limit: DB.FLOAT_TOP, ...o }).map((c) => c.item.uid).join();
    const got = (r) => r.copies.map((c) => c.item.uid).join();
    const sorted = (r, dir) => r.copies.every((c, i, l) => !i || (dir === 'low' ? l[i - 1].item.fl <= c.item.fl : l[i - 1].item.fl >= c.item.fl));
    const low = await alice.s('db.floats', { dir: 'low' }), high = await alice.s('db.floats', { dir: 'high' });
    check('float records: the lowest floats of every skin on the server, lowest first, as the engine orders them', got(low) === want({ dir: 'low' }) && sorted(low, 'low')
      && low.copies[0].item.uid === aStored.uid && low.copies[1].item.uid === aLow.uid && low.copies.length > 5, `${low.copies.length}: ${low.copies.slice(0, 4).map((c) => c.item.fl).join(', ')}`);
    check('float records: a Storage Unit\'s skin counts, and each copy says whose it is (yours or a player\'s, for the link)', low.copies[0].owner === 'alice' && low.copies[0].id === alice.id && low.copies[0].me === true
      && low.copies.find((c) => c.item.uid === bSt.uid)?.id === bob.id && low.copies.find((c) => c.item.uid === bSt.uid)?.me === false && !('src' in low.copies[0].item) && !('su' in low.copies[0].item));
    check('float records: the highest floats, highest first', got(high) === want({ dir: 'high' }) && sorted(high, 'high') && high.copies[0].item.uid === bHigh.uid && high.copies[1].item.uid === aHigh.uid,
      high.copies.slice(0, 3).map((c) => c.item.fl).join(', '));
    const every = [...low.copies, ...high.copies];
    check('float records: only skins with a float: no vanilla knife, no sticker', every.every((c) => c.item.t === 'skin' && typeof c.item.fl === 'number') && !every.some((c) => c.item.uid === bVanilla.uid || c.item.uid === sticker.uid));
    const st = await alice.s('db.floats', { dir: 'low', cat: 'st' }), sv = await alice.s('db.floats', { dir: 'low', cat: 'sv' }), n = await alice.s('db.floats', { dir: 'high', cat: 'n' });
    check('float records: by category, StatTrak™, Souvenir or Normal copies only', got(st) === want({ dir: 'low', cat: 'st' }) && st.copies[0].item.uid === bSt.uid && st.copies.every((c) => c.item.stt && !c.item.sv)
      && got(sv) === want({ dir: 'low', cat: 'sv' }) && sv.copies[0].item.uid === bSv.uid && sv.copies.every((c) => c.item.sv)
      && got(n) === want({ dir: 'high', cat: 'n' }) && n.copies[0].item.uid === bHigh.uid && n.copies.every((c) => !c.item.stt && !c.item.sv), `${st.copies.length} st, ${sv.copies.length} sv, ${n.copies.length} n`);
    const three = await alice.s('db.floats', { dir: 'low', limit: 3 }), one = await bob.s('db.floats', { dir: 'high', limit: 1 });
    check('float records: a limit gives the first of the same list', got(three) === low.copies.slice(0, 3).map((c) => c.item.uid).join() && one.copies.length === 1 && one.copies[0].item.uid === bHigh.uid && one.copies[0].me === true);
    const bad = await Promise.all([{ dir: 'sideways' }, { dir: 5 }, { cat: 'gold' }, { cat: ['st'] }, { limit: 0 }, { limit: DB.FLOAT_TOP + 1 }, { limit: 2.5 }, { limit: '5' }].map((a) => refused(alice.s('db.floats', a))));
    check('float records: a wrong direction, category or limit is refused', bad.every((e) => e?.code === 'bad'), bad.map((e) => e?.message).join(' | '));
    // Kept a little while for everyone: a lower float shows once that's past.
    const cLow = mk(1e-9);
    await giveItems(carol, [cLow]);
    await server.store.flush();
    const cached = await carol.s('db.floats', { dir: 'low', limit: 1 });
    passTime(FLOATS_MS + 1);
    const later = await carol.s('db.floats', { dir: 'low', limit: 1 });
    check('float records: kept a few seconds for every player, then asked again', cached.copies[0].item.uid === aStored.uid && cached.copies[0].me === false && later.copies[0].item.uid === cLow.uid && later.copies[0].me === true);
    // One pass over every save gives all eight lists, however many are asked for; a slow pass counts from when it ended.
    let passes = 0;
    F.db = { query: (...q) => { passes++; return server.db.query(...q).finally(() => passTime(FLOATS_MS * 2)); } }; // (each pass "takes" 30 s)
    passTime(FLOATS_MS + 1);
    const eight = await Promise.all(['low', 'high'].flatMap((dir) => DB.COPY_CATS.map((cat) => carol.s('db.floats', { dir, cat }))));
    const afterSlow = await bob.s('db.floats', { dir: 'high', cat: 'sv' });
    F.db = server.db;
    const now = (await server.db.query('SELECT id, state FROM users')).rows.flatMap((u) => ownedItems(typeof u.state === 'string' ? JSON.parse(u.state) : u.state).map((item) => ({ id: u.id, item })));
    const wantAll = ['low', 'high'].flatMap((dir) => DB.COPY_CATS.map((cat) => DB.floatRecords(now, { dir, cat }).map((c) => c.item.uid).join()));
    check('float records: one pass gives every direction and category, each as the engine has it', passes === 1 && eight.every((r, i) => got(r) === wantAll[i]), `${passes} passes`);
    check('float records: a pass that took longer than they\'re kept is kept from when it ended, not run again at once', passes === 1 && got(afterSlow) === wantAll[7], `${passes} passes`);
  }

  // ---- the item database: an item with more copies than db.item sends (ItemCopies) -----------------------------------
  {
    const DB = await import('../src/js/engine/database.js');
    const { ownedItems } = await import('../src/js/engine/storage.js');
    const C = server.srv.itemCopies, cap0 = C.cap;
    const def = Object.values(D.skins).filter((s) => !s.v && s.stt)[3];
    const mk = (fl, sd, x = {}) => makeSkinItem(def, { src: 'test', fl, sd, stt: false, ...x });
    // 14 copies over three players, an inventory and a Storage Unit: patterns 7 (×4: 2 Normal, 1 StatTrak™, 1 Souvenir), 9, 11.
    const lowest = { ...mk(1e-9, 7), su: 'unit-many', sat: Date.now() }, highest = mk(0.9999999, 9, { stt: true });
    const theirs = [mk(0.2, 7), mk(0.3, 7, { stt: true }), mk(0.4, 9), mk(0.5, 11), mk(0.6, 11, { sv: true }), mk(0.7, 7, { sv: true })];
    const yours = [mk(0.15, 9), mk(0.25, 11), mk(0.35, 7), mk(0.45, 9, { stt: true }), mk(0.55, 11, { stt: true })];
    await giveItems(dave, theirs);
    await giveItems(erin, [highest, mk(0.65, 9, { sv: true })]);
    await giveItems(carol, yours);
    await server.store.withUser(carol.id, async (e) => { e.st.stored = [...(e.st.stored || []), lowest]; server.store.markDirty(e); });
    await server.store.flush();
    const every = (await server.db.query('SELECT id, state FROM users')).rows.flatMap((u) => ownedItems(typeof u.state === 'string' ? JSON.parse(u.state) : u.state).map((item) => ({ id: u.id, item })))
      .filter((c) => c.item.t === 'skin' && c.item.id === def.id);
    const small = await carol.s('db.item', { t: 'skin', id: def.id });
    check('db.item: an item with no more copies than it sends sends every one, and no counts', small.copies.length === every.length && every.length >= 14 && !('counts' in small), `${small.copies.length} of ${every.length}`);
    C.cap = 18; // (three categories: the three lowest and three highest of each)
    const big = await carol.s('db.item', { t: 'skin', id: def.id });
    C.cap = cap0;
    const pats = DB.patternCounts(every), cats = { n: 0, st: 0, sv: 0 };
    for (const c of every) cats[DB.copyCategory(c.item)]++;
    const ends = new Set(['n', 'st', 'sv'].flatMap((k) => { const l = every.filter((c) => DB.copyCategory(c.item) === k).sort((a, b) => DB.byFloat(a.item, b.item)); return [...l.slice(0, 3), ...l.slice(-3)].map((c) => c.item.uid); }));
    const sameSet = (r) => r.copies.length === ends.size && r.copies.every((c) => ends.has(c.item.uid));
    check('db.item: more copies than it sends: at most that many, the lowest and highest floats of each category', sameSet(big) && big.copies.length <= 18 && big.copies.length < every.length
      && big.copies.some((c) => c.item.uid === lowest.uid && c.me === true) && big.copies.some((c) => c.item.uid === highest.uid && c.id === erin.id), `${big.copies.length} of ${every.length}: ${big.copies.map((c) => c.item.fl).join()}`);
    const rankOf = (m) => JSON.stringify([...m].map(([uid, r]) => [uid, r.low, r.high]).sort());
    check('db.item: so float ranks over the copies sent are every copy\'s', rankOf(DB.floatRanks(big.copies.map((c) => c.item))) === rankOf(DB.floatRanks(every)));
    check('db.item: and the counts of every copy: in all, owners, by category, and by pattern as the engine counts them', big.counts.total === every.length && big.counts.owners === new Set(every.map((c) => c.id)).size
      && JSON.stringify(big.counts.cats) === JSON.stringify(cats) && Object.keys(big.counts.pats).length === pats.size && [...pats].every(([k, n]) => big.counts.pats[k] === n)
      && big.counts.pats['all:7'] >= 5 && big.counts.pats['sv:7'] >= 1, JSON.stringify(big.counts));
    C.cap = 4; // (less than three an end: still the three ranks need)
    const tiny = await carol.s('db.item', { t: 'skin', id: def.id });
    C.cap = cap0;
    check('db.item: a cap under three an end still sends each category\'s three lowest and highest floats', sameSet(tiny) && tiny.counts.total === every.length);
  }

  // ---- last online --------------------------------------------------------------------------------------------------
  // (Set far back, as a player who only chats leaves it: a save is the only other thing that moves it.)
  const seenOf = async (c) => Number((await server.db.query('SELECT last_seen FROM users WHERE id = $1', [c.id])).rows[0].last_seen);
  fresh();
  const leaver = await client(tok.zedxy), secondTab = await client(tok.zedxy);
  await leaver.s('friend', { id: dave.id, on: true });
  await dave.s('friend', { id: leaver.id, on: true });
  await server.db.query('UPDATE users SET last_seen = 1000 WHERE id = $1', [leaver.id]);
  dave.forget();
  leaver.close();
  await wait(150);
  check('last online: not while another of their tabs is still connected', await seenOf(leaver) === 1000 && !dave.pushed('friends').length, String(await seenOf(leaver)));
  secondTab.close();
  const leftPush = await dave.waitFor((e) => e.t === 'friends');
  const gone = (await dave.s('home')).friends.find((p) => p.id === leaver.id);
  check('last online: their last connection closing sets it, and friends are told so a page that\'s open shows it', !!leftPush && Math.abs(await seenOf(leaver) - Date.now()) < 5000 && Math.abs(gone?.seen - Date.now()) < 5000 && gone?.online === false, JSON.stringify(gone));
  await dave.s('friend', { id: leaver.id, on: false });

  // ---- deleted accounts, restarts ---------------------------------------------------------------------------------
  const goner = await register('goner');
  const gid = (await server.db.query("SELECT id FROM users WHERE name_lc = 'goner'")).rows[0].id;
  await server.db.query("INSERT INTO messages (from_id, to_id, text, at) VALUES ($1, $2, 'x', 1)", [gid, alice.id]);
  await server.db.query('INSERT INTO blocks (user_id, blocked_id, at) VALUES ($1, $2, 1)', [gid, alice.id]);
  await server.db.query("INSERT INTO friends (a, b, status, asked_by, since) VALUES ($1, $2, 'pending', $2, 1)", [Math.min(gid, bob.id), Math.max(gid, bob.id)]);
  await server.db.query("INSERT INTO reports (from_id, about_id, reason, text, messages, at) VALUES ($1, $2, 'x', '', '[]'::jsonb, 1)", [gid, alice.id]);
  await server.db.query('DELETE FROM users WHERE id = $1', [gid]);
  check('a deleted account leaves nothing behind', goner && await count('SELECT count(*)::int AS n FROM messages WHERE from_id = $1 OR to_id = $1', [gid]) === 0 && await count('SELECT count(*)::int AS n FROM blocks WHERE user_id = $1', [gid]) === 0
    && await count('SELECT count(*)::int AS n FROM friends WHERE a = $1 OR b = $1', [gid]) === 0 && await count('SELECT count(*)::int AS n FROM reports WHERE from_id = $1', [gid]) === 0);

  fresh();
  const kept1 = await alice.s('profile', { id: alice.id });
  await carol.s('block', { id: erin.id, on: true });
  await send(alice, bob, 'survives a restart');
  for (const c of [alice, bob, carol, dave, erin, frank, boss, moddy]) c.close();
  await server.close();
  server = await start(); // (every migration again, on the same database)
  useClock();
  fakeDiscord();
  const a2 = await client(tok.alice), b2 = await client(tok.bob), c2 = await client(tok.carol);
  const afterRestart = await a2.s('profile', { id: a2.id });
  check('restart: the migrations run again on a live database, and everything is still there', afterRestart.bio === kept1.bio && afterRestart.avatar === kept1.avatar && (await b2.s('home')).chats.some((c) => c.last.text === 'survives a restart') && ids((await c2.s('home')).blocked).length === 1);
  for (const c of [a2, b2, c2]) c.close();
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
await server.close().catch((e) => console.error('close failed', e));
const crashed = logs.filter((l) => /^\[rpc\]/.test(l));
check('no request ended in a server error', !crashed.length, crashed.slice(0, 3).join(' | '));
if (failed || process.argv.includes('--log')) console.log('\n--- log ---\n' + logs.join('\n'));
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
