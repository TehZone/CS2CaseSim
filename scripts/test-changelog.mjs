// Checks for the in-game changelog (scripts/build-changelog.mjs): the file matches git, it comes from the same source as
// the Discord update log, every commit is accounted for, and nothing players shouldn't read gets through.
//   node scripts/test-changelog.mjs      (if the file is only out of date: npm run changelog)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUT, NEVER, REVIEW, readCommits, loadNotes, classify, parse, buildChangelog, serialize } from './build-changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SERVER = 'cs2-case-sim-server.onrender.com';

let failed = 0, passed = 0;
function check(name, ok, info = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}

const commits = readCommits(), notes = loadNotes();
const inputs = { commits, notes, versions: JSON.parse(read('scripts/data/changelog-versions.json')), version: JSON.parse(read('package.json')).version };
const want = buildChangelog(inputs);
const onDisk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

// ---- it matches git ------------------------------------------------------------------------------------------------
check('the file is there', onDisk != null, onDisk != null ? '' : 'run npm run changelog');
check('the file is up to date with git', onDisk === serialize(want), onDisk === serialize(want) ? '' : 'run npm run changelog');
{
  const stale = { ...want, updates: want.updates.slice(1) };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-')), 'changelog.json');
  const run = () => spawnSync(process.execPath, ['scripts/build-changelog.mjs', '--check', file], { cwd: ROOT, encoding: 'utf8' });
  fs.writeFileSync(file, serialize(stale));
  check('--check fails on a file missing the newest update', run().status === 1);
  fs.writeFileSync(file, serialize(want));
  check('--check passes on a current file', run().status === 0);
  fs.rmSync(path.dirname(file), { recursive: true });
}
check('two runs give the same file', serialize(buildChangelog(inputs)) === serialize(want));
check('git ignores the generated file', spawnSync('git', ['check-ignore', '-q', 'src/data/changelog.json'], { cwd: ROOT }).status === 0);

// ---- the same source as the Discord update log -----------------------------------------------------------------------
{
  const discord = read('scripts/discord-setup.mjs'), mine = read('scripts/build-changelog.mjs');
  const FORMAT = "['log', '--reverse', '--format=%at%x1f%ad%x1f%s', '--date=format:%Y-%m-%d'";
  check('the two logs read git the same way', discord.includes(FORMAT) && mine.includes(FORMAT));
  const out = execFileSync('git', ['rev-list', '--count', JSON.parse(read('scripts/data/discord-server.json')).updateLog.branch], { cwd: ROOT, encoding: 'utf8' });
  check('every commit on the update log\'s branch is read', commits.length === +out, `${commits.length} of ${out.trim()}`);
  const shown = commits.filter((c) => classify(c.subject, notes).text), hidden = commits.filter((c) => classify(c.subject, notes).hide);
  check('every commit is either shown or hidden', shown.length + hidden.length === commits.length && want.updates.length === shown.length, `${shown.length} shown, ${hidden.length} hidden`);
  check('each update is on the day and at the time of its commit', want.updates.every((u, i) => { const c = shown.at(-1 - i); return c.at === u.at && c.day === u.day; }));
  const subjects = new Set(commits.map((c) => c.subject));
  const unused = [...notes.hidden.keys(), ...Object.keys(notes.rewrite)].filter((s) => !subjects.has(s));
  check('every note in changelog-notes.json is for a real commit', !unused.length, unused.join(' / '));
}

// ---- how it reads --------------------------------------------------------------------------------------------------
check('newest first', want.updates.every((u, i, a) => !i || a[i - 1].at >= u.at));
check('every update has its fields', want.updates.every((u) => Number.isInteger(u.at) && /^\d{4}-\d\d-\d\d$/.test(u.day) && /^\d+\.\d+\.\d+$/.test(u.version) && u.area && u.text));
check('the update window can ask for a version', want.updates.some((u) => u.version === want.version));
{
  const a = parse('Play mode: a soccer ball'), b = parse('Charms hang anywhere'), c = parse('Play: net_graph 2 logs'), d = parse('Name Tags: rename your skins');
  check('areas and capitals', a.area === 'Play' && a.text === 'A soccer ball' && b.area === 'Charms' && b.text === 'Charms hang anywhere' && c.text === 'net_graph 2 logs' && d.area === 'Name Tags');
  const log = buildChangelog({ commits: [1, 2, 3, 4].map((at) => ({ at, day: '2026-01-01', subject: `Cases: update ${at}` })), notes: { hidden: new Map(), rewrite: {} }, versions: { '1.0.0': 1, '1.1.0': 3 }, version: '1.2.0' });
  check('a version ends at its last update, and the rest are the current version', log.updates.map((u) => u.version).join() === '1.2.0,1.1.0,1.1.0,1.0.0');
}

// ---- what players must not see ---------------------------------------------------------------------------------------
{
  check('the server\'s address isn\'t in the file', !serialize(want).includes(SERVER) && !serialize(want).includes('onrender'));
  const bad = want.updates.flatMap((u) => [u.text, u.area].filter((t) => NEVER.some(([, re]) => re.test(t))));
  check('no address, file name, code, hash or trailer', !bad.length, bad.join(' / '));
  const staff = REVIEW.find(([n]) => n === 'staff tools')[1];
  check('nothing about the staff tools or the Discord server', !want.updates.some((u) => staff.test(u.text) || staff.test(u.area)));
  const keys = want.updates.flatMap(Object.keys);
  check('nothing extra ships with an update', keys.every((k) => ['at', 'day', 'version', 'area', 'text'].includes(k)));

  const none = { hidden: new Map(), rewrite: {} };
  for (const s of [
    'Admin panel: bans show who made them', 'Staff: a new audit view', 'Discord: a new channel', 'Tests: a new check', 'README: new section', 'Smoke: count more', 'Smoke test: wait longer',
    'Merge branch claude/serene', 'Revert "Play: faster"', 'Script to fetch prices', 'Server: faster start up', 'Deploy: new region',
    `Online: ${SERVER} answers faster`, 'Online: https://example.com/status', 'Market: fix src/js/pages/market.js', 'Inventory: tidy game-data.json', 'Play: matches pay through play.start',
    'Play: the HUD keeps its .msg style', 'Cases: 3f4ed57 undone', 'Co-Authored-By: Claude Opus 5.5', 'Market: buying twice gave items for free', 'Trade: a dupe closed', 'Gamble: the exploit is gone',
    'Accounts: the token lasts longer', 'Play: anti-cheat bypass fixed', 'Market: moved to keepPrepared', 'Trade: CS2SIM_SMOKE_SERVER works again', 'Tools: tests for the rename',
  ]) check(`held back: ${s}`, !!classify(s, none).hide);
  for (const s of [
    'Play: you play as the agent you have equipped, on both sides', 'Name Tags: rename your skins', 'StatTrak Swap Tool: swap counters between two guns',
    'Faster smoke bloom', 'Tools: a new look for the Tools tab', 'Market: every charm listed with its own pattern number', 'Play: a 4:3 stretched option',
  ]) check(`shown as written: ${s}`, classify(s, none).text === s);
  let threw = false;
  try { classify('x', { hidden: new Map(), rewrite: { x: `Online: see ${SERVER}` } }); } catch { threw = true; }
  check('a reviewed note can\'t carry an address either', threw);
}

// ---- the build makes it ------------------------------------------------------------------------------------------------
{
  const build = read('scripts/build-exe.mjs');
  const made = build.indexOf("changelog(...("), copied = build.indexOf('fs.cpSync'), staged = build.indexOf("changelog('--check'"), packed = build.indexOf('electron-builder --win');
  check('the build makes the changelog before it copies the game', made > 0 && made < copied);
  check('and checks the staged copy before it packs the exe', staged > copied && staged < packed);
  check('the unpacked build makes it too', /build-changelog\.mjs.*electron-builder/.test(JSON.parse(read('package.json')).scripts['dist:dir']));
  check('the exe takes the file', JSON.parse(read('package.json')).build.files.includes('src/**/*'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
