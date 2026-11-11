// The version lock's tests: a real server (embedded Postgres on disk) and real WebSocket clients, with a stand-in for
// GitHub's latest.json. Nothing here reaches the internet.
//   node server/test-release.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

delete process.env.RELEASE_FEED;
const { startServer } = await import('./index.mjs');
const { releaseFromEnv } = await import('./release.mjs');
const { D } = await import('../src/js/engine/data.js');
const { RELEASE_PAGE } = createRequire(import.meta.url)('../shared/release.cjs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2sim-test-release-'));
let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(20); } return null; };

// What GitHub answers: a function, so a test can make it fail.
let github = () => new Response('Not Found', { status: 404 });
const asked = [];
const fetcher = async (url) => { asked.push(String(url)); return github(); };
const FILE = { name: 'CS2-Case-Simulator.exe', size: 100, sha256: 'a'.repeat(64) };
const published = (version) => () => Response.json({ version, notes: 'Notes', files: { portable: FILE } });
const logs = [];
const start = (release) => startServer({ port: 0, db: { dataDir: DIR }, log: (...a) => logs.push(a.join(' ')), priceRefresh: false, discord: false, release });
const lock = { fetcher, every: 3600000, grace: 150 };

let server = await start(lock);
const base = () => `http://localhost:${server.port}`;
const post = async (p, body) => (await fetch(base() + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

// A game on a version (null: an exe from before the updater, which sends none). Resolves once it's let in or refused.
function connect(token, app) {
  const ws = new WebSocket(base().replace('http', 'ws') + '/ws');
  const c = { ws, msgs: [], welcome: null, fatal: null, closed: false };
  ws.on('close', () => { c.closed = true; });
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, data: D.lock, v: 1, ...(app === null ? {} : { app }) })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      c.msgs.push(m);
      if (m.t === 'welcome') { c.welcome = m; resolve(c); }
      if (m.t === 'fatal') { c.fatal = m; resolve(c); }
    });
  });
}
const players = async () => (await (await fetch(base() + '/health')).json()).online;

try {
  // ---- when it's on -----------------------------------------------------------------------------------------------
  check('off by default on a developer\'s PC, on by itself on Render, RELEASE_FEED switches it either way',
    releaseFromEnv({}) === false && typeof releaseFromEnv({ NODE_ENV: 'production' }) === 'object'
    && releaseFromEnv({ NODE_ENV: 'production', RELEASE_FEED: 'off' }) === false && releaseFromEnv({ RELEASE_FEED: 'http://x/' }).feed === 'http://x/');

  const tok = (await post('/api/register', { name: 'alice', password: 'secret123' })).token;
  const tok2 = (await post('/api/register', { name: 'bob_2', password: 'hunter222' })).token;
  const tok3 = (await post('/api/register', { name: 'carol', password: 'hunter333' })).token;
  await until(() => asked.length >= 1);

  // ---- before any release -----------------------------------------------------------------------------------------
  check('no release yet: nothing is required (the server can go live before the release does)', server.srv.release.required === null);
  let old = await connect(tok, null);
  check('no release yet: an exe that sends no version still plays', !!old.welcome && !old.fatal);
  old.ws.close();
  await until(async () => (await players()) === 0);

  // ---- a release is published -------------------------------------------------------------------------------------
  github = published('1.2.0');
  await server.srv.release.poll();
  check('a published release becomes the required version', server.srv.release.required === '1.2.0');
  check('/health says which version is required', (await (await fetch(base() + '/health')).json()).requiredVersion === '1.2.0');

  old = await connect(tok, null);
  check('an exe that sends no version is refused with the code the game knows', old.fatal?.code === 'outdated' && !old.welcome);
  check('the refusal reads on its own in an old exe: why, which version, and where to get it (no markup)',
    /out of date/.test(old.fatal?.error) && /1\.2\.0/.test(old.fatal?.error) && old.fatal?.error.includes(RELEASE_PAGE) && !/[<>]/.test(old.fatal?.error), old.fatal?.error);
  check('the refusal tells the new game the version', old.fatal?.required === '1.2.0');
  check('a refused game is closed', await until(() => old.closed));

  for (const [app, why] of [['1.1.9', 'an older patch'], ['1.1.100', 'numbers, not text: 1.1.100 is still before 1.2.0'], ['0.99.99', 'an older major'], ['nonsense', 'garbage'], ['', 'empty'], [12, 'not a string'], [{ a: 1 }, 'an object'], ['1.2', 'half a version']]) {
    const c = await connect(tok, app);
    check(`refused: ${why} (${JSON.stringify(app)})`, c.fatal?.code === 'outdated' && !c.welcome);
  }
  // (A bad token: the version comes first, so the old game gets the message it can read rather than a login error.)
  const noLogin = await connect('not-a-token', '1.0.0');
  check('the version is checked before the login', noLogin.fatal?.code === 'outdated');
  const wrongData = new WebSocket(base().replace('http', 'ws') + '/ws');
  const wrong = await new Promise((res) => {
    wrongData.on('open', () => wrongData.send(JSON.stringify({ t: 'hello', token: tok, data: 'another-build', v: 1, app: '1.0.0' })));
    wrongData.on('message', (raw) => res(JSON.parse(raw)));
  });
  check('an old game with other game data still gets the update message, not the data one', wrong.code === 'outdated');

  const same = await connect(tok, '1.2.0');
  check('the required version plays', !!same.welcome);
  same.ws.close();
  const newer = await connect(tok, '1.10.0');
  check('a newer version plays (1.10.0 is after 1.2.0, numerically)', !!newer.welcome);
  newer.ws.close();
  const prefixed = await connect(tok, 'v1.2.0');
  check('a v in front changes nothing', !!prefixed.welcome);
  prefixed.ws.close();
  await until(async () => (await players()) === 0);

  // ---- GitHub failing ---------------------------------------------------------------------------------------------
  for (const [what, answer] of [
    ['an outage (no answer at all)', () => { throw new Error('getaddrinfo ENOTFOUND github.com'); }],
    ['a 500', () => new Response('oops', { status: 500 })],
    ['a rate limit', () => new Response('slow down', { status: 429 })],
    ['a 404 (the file gone)', () => new Response('Not Found', { status: 404 })],
    ['an error page instead of JSON', () => new Response('<html>Unicorn!</html>', { status: 200 })],
    ['a file with no version', () => Response.json({ files: { portable: FILE } })],
    ['a version with no files to update to', () => Response.json({ version: '9.9.9', files: {} })],
  ]) {
    github = answer;
    const ok = await server.srv.release.poll();
    check(`${what} keeps the last known version`, ok === false && server.srv.release.required === '1.2.0');
  }
  let still = await connect(tok, '1.2.0');
  check('during an outage the current version still plays', !!still.welcome);
  still.ws.close();
  still = await connect(tok, '1.1.0');
  check('during an outage an older version is still refused', still.fatal?.code === 'outdated');
  await until(async () => (await players()) === 0);

  // ---- restarts ---------------------------------------------------------------------------------------------------
  await server.close();
  github = () => { throw new Error('still down'); };
  server = await start(lock);
  await until(() => logs.some((l) => l.includes('still down')));
  check('a restart during an outage keeps the version (it is in the database)', server.srv.release.required === '1.2.0');
  still = await connect(tok, '1.1.0');
  check('and the lock still holds', still.fatal?.code === 'outdated');

  // ---- players connected when a release comes out -----------------------------------------------------------------
  github = published('1.2.0');
  await server.srv.release.poll();
  const current = await connect(tok, '1.2.0');
  const behind = await connect(tok2, '1.2.0');
  const noVersion = await connect(tok3, '1.2.0');
  check('three players connected', await until(async () => (await players()) === 3));
  behind.ws.close();
  noVersion.ws.close();
  await until(async () => (await players()) === 1);
  server.srv.release.required = '1.1.0'; // (let the older games in, as they were before this release)
  const onOld = await connect(tok2, '1.1.5');
  const onNone = await connect(tok3, '1.1.5');
  server.srv.release.required = '1.2.0';
  current.ws.close();
  await until(async () => (await players()) === 2);
  const stays = await connect(tok, '1.3.0');
  github = published('1.3.0');
  await server.srv.release.poll();
  check('the new version is required at once', server.srv.release.required === '1.3.0');
  const warned = await until(() => onOld.msgs.some((m) => m.t === 'notice') && onOld.msgs.some((m) => m.t === 'update' && m.version === '1.3.0'));
  check('players on older versions are told right away (a notice every exe can show, and word for the updater)', warned, onOld.msgs.find((m) => m.t === 'notice')?.msg);
  check('they are not dropped yet', !onOld.closed && (await players()) === 3);
  check('a player on the new version hears nothing', !stays.msgs.some((m) => m.t === 'update' || m.t === 'notice'));
  await until(() => onOld.closed && onNone.closed);
  check('after the wait they are dropped, with the reason', onOld.fatal?.code === 'outdated' && onOld.fatal?.required === '1.3.0' && onNone.fatal?.code === 'outdated');
  check('the player on the new version stays', !stays.closed);
  check('the players count goes down with them', await until(async () => (await players()) === 1));
  const back = await connect(tok2, '1.1.5');
  check('and they can\'t come back on the old version', back.fatal?.code === 'outdated');
  const updated = await connect(tok2, '1.3.0');
  check('but can once updated', !!updated.welcome);
  updated.ws.close();
  stays.ws.close();

  // ---- a release taken back ---------------------------------------------------------------------------------------
  github = published('1.2.0');
  await server.srv.release.poll();
  check('the newest release going back to an older one lowers the version again', server.srv.release.required === '1.2.0');
  const again = await connect(tok2, '1.2.0');
  check('and that version plays again', !!again.welcome);
  again.ws.close();

  // ---- switched off -----------------------------------------------------------------------------------------------
  await server.close();
  server = await start(false);
  const free = await connect(tok, null);
  check('with the lock off (RELEASE_FEED=off, or a developer\'s PC) every version plays, whatever was saved', !!free.welcome);
  free.ws.close();
} catch (e) {
  failed++;
  console.error('FAIL  test crashed:', e);
}
await server.close().catch(() => {});
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
