// Custom content on the server (CUSTOM_CONTENT.md): the data lock with and without it (a game from before custom content,
// 1.1.3, keeps connecting while there's none), and custom items online: opening a custom case, trading and selling a custom
// drop, the price patch and saved prices. A real server (embedded Postgres) and real WebSocket clients.
//   node server/test-custom.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

for (const k of ['HOST', 'SERVER_COMMIT', 'RENDER_GIT_COMMIT', 'RELEASE_FEED']) delete process.env[k];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startServer, readCustom } = await import('./index.mjs');
const { D, casePrice, keyFor } = await import('../src/js/engine/data.js');
const { itemValue, makeSkinItem } = await import('../src/js/engine/items.js');
const { buildCustom, writeBuild } = await import('../scripts/build-custom.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-custom-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};
const GENERATED = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8')).generatedAt;

// The example pack, built into a scratch folder (never into the game's src/).
const src = path.join(TMP, 'packs');
fs.cpSync(path.join(ROOT, 'docs', 'custom-example'), src, { recursive: true, filter: (f) => !/make-textures\.mjs$|ids\.json$/.test(f) });
const built = buildCustom({ src });
if (!built.ok) { console.log(built.errors.join('\n')); process.exit(1); }
writeBuild(built, { out: path.join(TMP, 'out') });
const custom = JSON.parse(fs.readFileSync(path.join(TMP, 'out', 'data', 'custom.json'), 'utf8'));

let server = null;
const base = () => `http://localhost:${server.port}`;
async function post(p, body) {
  const r = await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
// A game client: its hello sends `data` (the lock it was built with) and `app` (its version).
async function client(token, { data = D.lock, app } = {}) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
  const c = { ws, st: null, pending: new Map(), seq: 0 };
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const welcome = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.st = m.state; c.user = m.user; res(m); return; }
      if (m.t === 'fatal') { rej(Object.assign(new Error(m.error), { code: m.code })); return; }
      if (m.t === 'res') { const p = c.pending.get(m.id); c.pending.delete(m.id); m.ok ? p.res(m.r) : p.rej(Object.assign(new Error(m.err), { code: m.code })); }
    });
  });
  ws.send(JSON.stringify({ t: 'hello', token, data, v: 1, ...(app ? { app } : {}) }));
  c.welcome = await welcome;
  c.rpc = (ns, m, args) => new Promise((res, rej) => { const id = ++c.seq; c.pending.set(id, { res, rej }); ws.send(JSON.stringify({ t: 'rpc', id, ns, m, args })); });
  c.act = (m, a) => c.rpc('act', m, a);
  c.close = () => ws.close();
  return c;
}
const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };

try {
  // ---- no custom content: exactly as before -----------------------------------------------------------------------------------
  check('src/data/custom.json isn\'t there, so a deployed server reads none', readCustom(path.join(ROOT, 'src', 'data', 'custom.json')) === null);
  server = await startServer({ port: 0, db: { dataDir: path.join(TMP, 'db1') }, log: quiet, priceRefresh: false, discord: false, release: false });
  const h0 = await (await fetch(base() + '/health')).json();
  check('without custom content /health\'s data is the game data\'s generatedAt, exactly as 1.1.3\'s', h0.data === GENERATED && D.lock === GENERATED, h0.data);
  const t0 = (await post('/api/register', { name: 'oldgame', password: 'secret123' })).body.token;
  const old = await client(t0, { data: GENERATED, app: '1.1.3' });
  check('a 1.1.3 game (its hello carries the raw generatedAt) is let in', !!old.welcome && old.user.name === 'oldgame');
  old.close();
  const p0 = await (await fetch(base() + '/api/prices')).json();
  check('its price patch is stamped with the raw generatedAt (1.1.3 games keep using it)', p0.generatedAt === GENERATED);
  await server.close();
  server = null;

  // ---- with custom content --------------------------------------------------------------------------------------------------
  const dir = path.join(TMP, 'db2');
  server = await startServer({ port: 0, db: { dataDir: dir }, log: quiet, priceRefresh: false, discord: false, release: false, custom });
  const h1 = await (await fetch(base() + '/health')).json();
  check('with custom content the lock is generatedAt + the custom hash', h1.data === `${GENERATED}+cx.${built.lock}` && D.lock === h1.data && D.generatedAt === GENERATED, h1.data);
  const ta = (await post('/api/register', { name: 'alice', password: 'secret123' })).body.token;
  const tb = (await post('/api/register', { name: 'bob', password: 'secret123' })).body.token;
  const was = await refused(client(ta, { data: GENERATED, app: '1.1.3' }));
  check('a game without that custom content is refused (its data differs: it would show custom items as Unknown)', was?.code === 'version', was?.message);
  const A = await client(ta), B = await client(tb);
  check('a game built with it connects', !!A.welcome && !!B.welcome);
  await server.store.withUser(A.user.id, async (e) => { e.st.money = 2000; server.store.markDirty(e); });
  await server.store.withUser(B.user.id, async (e) => { e.st.money = 500; server.store.markDirty(e); });

  const box = D.cases.find((c) => c.cx);
  const pool = new Set([...Object.values(box.pools).flat(), ...box.rare.flat()]);
  await A.act('case.buy', { id: box.id, n: 10 });
  await A.act('key.buy', { key: keyFor(box), n: 10 });
  const op = await A.act('case.open', { id: box.id, n: 10 });
  const after = (await server.store.load(A.user.id)).st;
  check('online: buying and opening the custom case (server side)', op.items.length === 10 && op.items.every((it) => pool.has(it.id)) && Math.abs(after.money - (2000 - casePrice(box) * 10)) < 0.011,
    op.items.map((it) => D.skins[it.id].n.split(' | ')[1]).join(', '));
  // Until a custom skin drops (about 1 open in 11 gives one: the odds of 100 opens giving none are 1 in 10,000).
  let customDrop = op.items.find((it) => D.skins[it.id].cx), opened = 10;
  while (!customDrop && opened < 100) {
    const more = await A.act('case.open', { id: box.id, n: 10, buy: true, maxCost: 100 });
    customDrop = more.items.find((it) => D.skins[it.id].cx);
    opened += 10;
  }
  const inInv = customDrop && (await server.store.load(A.user.id)).st.inv.find((it) => it.uid === customDrop.uid);
  check('online: a custom skin drops from the custom case and lands in the inventory (server side)', !!inInv && inInv.src === box.n && D.skins[inInv.id].cx === 1,
    customDrop ? `${D.skins[customDrop.id].n} after ${opened} opens` : 'none in 100 opens');
  const battle = await refused(A.act('case.open', { id: box.id, n: 1, buy: true, maxCost: 10 }));
  check('online: opening it with buy (as the Cases page does)', battle === null);

  // A custom skin drop (the AK) given to Alice, then traded to Bob, who sells it.
  const ak = Object.values(D.skins).find((s) => s.cx && s.n === 'AK-47 | Example Nebula');
  const knife = Object.values(D.skins).find((s) => s.cx && s.cat === 'knife');
  const drop = { ...makeSkinItem(ak, { fl: 0.05, sd: 12, stt: true }), src: box.n };
  const kdrop = { ...makeSkinItem(knife, { fl: 0.02, sd: 400, stt: false }), src: box.n };
  await server.store.withUser(A.user.id, async (e) => { e.st.inv.push(drop, kdrop); server.store.markDirty(e); });
  const offer = await A.rpc('trade', 'offer', { to: 'bob', give: { uids: [drop.uid, kdrop.uid], money: 0 }, get: { uids: [], money: 2 } });
  await wait(100);
  await B.rpc('trade', 'accept', { id: offer.id });
  await wait(100);
  const bst = (await server.store.load(B.user.id)).st, ast = (await server.store.load(A.user.id)).st;
  const got = bst.inv.find((it) => it.uid === drop.uid), gotKnife = bst.inv.find((it) => it.uid === kdrop.uid);
  check('online: trading custom items (an AK and a knife) moves them, float and seed kept', got?.id === ak.id && gotKnife?.id === knife.id && got.fl === drop.fl && got.sd === 12 && got.stt === true
    && !ast.inv.some((it) => it.uid === drop.uid || it.uid === kdrop.uid));
  const m0 = bst.money, v = itemValue(got);
  await B.act('item.sell', { uids: [got.uid] });
  const m1 = (await server.store.load(B.user.id)).st.money;
  check('online: selling a custom item pays its pack value', Math.abs(m1 - m0 - v) < 0.011 && v > 70, `$${v}`);

  // The price patch: custom prices are the pack's, and a saved patch from before this deploy doesn't change them.
  const patch = await (await fetch(base() + '/api/prices')).json();
  check('/api/prices carries custom prices and the custom case\'s, stamped with the custom lock', patch.generatedAt === D.lock && JSON.stringify(patch.skins[ak.id]) === JSON.stringify(custom.skins[ak.id].p) && patch.cases[box.id] === box.price);
  A.close(); B.close();
  await server.close();
  server = null;
  // A saved patch (the daily refresh's, from before custom content: the raw generatedAt) with other prices for everything.
  const { openDb } = await import('./db.mjs');
  const db = await openDb({ dataDir: dir });
  const realId = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'game-data.json'), 'utf8')).skins).find((id) => !/-cx-/.test(id));
  const saved = { generatedAt: GENERATED, pricedAt: '2099-01-01T00:00:00.000Z', skins: { [realId]: { FN: [123.45, null] }, [ak.id]: { FN: [0.01, 0.01] } }, stickers: {}, agents: {}, cases: { [box.id]: 0.01 } };
  await db.query("INSERT INTO kv (k, v) VALUES ('prices', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(saved)]);
  await db.close?.();
  server = await startServer({ port: 0, db: { dataDir: dir }, log: quiet, priceRefresh: false, discord: false, release: false, custom });
  check('saved prices (from before custom content) still apply to real items after the deploy', D.skins[realId].p.FN?.[0] === 123.45);
  check('…but never to custom ones: those are always their pack\'s', JSON.stringify(D.skins[ak.id].p) === JSON.stringify(custom.skins[ak.id].p) && D.caseById[box.id].price === box.price);
  const patch2 = await (await fetch(base() + '/api/prices')).json();
  check('and the patch games get has the pack\'s prices', JSON.stringify(patch2.skins[ak.id]) === JSON.stringify(custom.skins[ak.id].p) && patch2.skins[realId].FN[0] === 123.45);
  check('the saved patch\'s custom prices weren\'t these, so it\'s a new patch (a new pricedAt: games that kept the old one download it)', D.pricedAt !== saved.pricedAt && patch2.pricedAt === D.pricedAt && !!patch2.cxp && patch2.marketAt === saved.pricedAt);
  const pricedBefore = D.pricedAt;
  await server.close();
  server = null;

  // ---- a deploy that only changes custom prices (the lock stays) ---------------------------------------------------------------
  {
    const s = path.join(TMP, 'packs-prices');
    fs.cpSync(src, s, { recursive: true, filter: (f) => !/ids\.json$/.test(f) });
    const edit = (f, fn) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j)); };
    edit(path.join(s, 'skins', 'AK-47 - Example Nebula', 'skin.json'), (j) => { j.prices.FN = 4.25; });
    edit(path.join(s, 'cases', 'Example Case', 'case.json'), (j) => { j.price = 9.95; });
    const b = buildCustom({ src: s });
    check('(a price-only change keeps the lock)', b.ok && b.lock === built.lock);
    server = await startServer({ port: 0, db: { dataDir: dir }, log: quiet, priceRefresh: false, discord: false, release: false, custom: b.custom });
    const p3 = await (await fetch(base() + '/api/prices')).json();
    const tc = (await post('/api/register', { name: 'carol', password: 'secret123' })).body.token;
    const C = await client(tc);
    check('a price-only deploy gives a new pricedAt, so a game that kept the earlier patch downloads the new prices', C.welcome.pricedAt === p3.pricedAt && p3.pricedAt !== pricedBefore
      && p3.skins[ak.id].FN[0] === 4.25 && p3.cases[box.id] === 9.95 && D.caseById[box.id].price === 9.95);
    check('…and the daily refresh still goes by when the marketplaces were read', p3.marketAt === saved.pricedAt);
    C.close();
    await server.close();
    server = null;
    server = await startServer({ port: 0, db: { dataDir: dir }, log: quiet, priceRefresh: false, discord: false, release: false, custom: b.custom });
    check('…once: the next start with the same prices keeps that pricedAt', D.pricedAt === p3.pricedAt);
    await server.close();
    server = null;
  }

  // ---- the release gate: custom content waits for the release that ships it ------------------------------------------------------
  {
    const FILE = { name: 'CS2-Case-Simulator.exe', size: 100, sha256: 'a'.repeat(64) };
    let latest = '1.1.3';
    const feed = { fetcher: async () => Response.json({ version: latest, notes: '', files: { portable: FILE } }), every: 3600000, grace: 150 };
    let restarts = 0;
    const gdir = path.join(TMP, 'db-gate');
    const start = (c) => startServer({ port: 0, db: { dataDir: gdir }, log: quiet, priceRefresh: false, discord: false, release: feed, custom: c, restart: () => { restarts++; } });
    const v999 = { ...custom, app: '9.9.9' };
    const lock1 = `${GENERATED}+cx.${built.lock}`;
    server = await start(v999);
    let h = await (await fetch(base() + '/health')).json();
    check('pushed before its release (9.9.9; 1.1.3 is out), the custom content waits: the server\'s lock stays 1.1.3\'s', h.data === GENERATED && D.lock === GENERATED && !D.cx && h.customWaits === '9.9.9' && h.customLock === lock1, JSON.stringify({ data: h.data, waits: h.customWaits }));
    const t1 = (await post('/api/register', { name: 'gate1', password: 'secret123' })).body.token;
    const g113 = await refused(client(t1, { data: GENERATED, app: '1.1.3' }));
    check('…so 1.1.3 keeps playing online', g113 === null);
    const early = await refused(client(t1, { data: lock1, app: '9.9.9' }));
    check('a game that has it, before the server does, is told the server is switching (not to update)', early?.code === 'version' && /switching to this version/.test(early.message), early?.message);
    latest = '9.9.9';
    await server.srv.release.poll();
    await wait(3300);
    check('once its release is published the server starts again (to run it)', restarts === 1, `${restarts} restarts`);
    await server.close();
    server = null;
    server = await start(v999);
    h = await (await fetch(base() + '/health')).json();
    check('started again, it runs the custom content (its lock), and 9.9.9 games play', h.data === lock1 && !h.customWaits && !!(await client(t1, { data: lock1, app: '9.9.9' })).welcome);
    await server.close();
    server = null;
    // The next content (another lock), pushed before 9.9.10 is out: the server keeps running 9.9.9's, which it kept.
    const s = path.join(TMP, 'packs-next');
    fs.cpSync(src, s, { recursive: true, filter: (f) => !/ids\.json$/.test(f) });
    const edit = (f, fn) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j)); };
    edit(path.join(s, 'skins', 'AK-47 - Example Nebula', 'skin.json'), (j) => { j.float = [0, 0.6]; j.prices = { FN: 40, MW: 20, FT: 12, WW: 10, BS: 9 }; });
    const next = buildCustom({ src: s });
    server = await start({ ...next.custom, app: '9.9.10' });
    h = await (await fetch(base() + '/health')).json();
    check('newer content pushed before its release: the server runs what 9.9.9 has (kept from its last run), so 9.9.9 games keep playing', next.lock !== built.lock && h.data === lock1 && h.customWaits === '9.9.10'
      && D.cx?.skins === 4 && !!(await client(t1, { data: lock1, app: '9.9.9' })).welcome, h.data);
    await server.close();
    server = null;
    check('(no other restart was asked for)', restarts === 1);
  }
} finally {
  await server?.close().catch(() => {});
  await wait(200);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
