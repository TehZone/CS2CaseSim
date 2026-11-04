// Makes src/data/changelog.json: what the game's Changelog page shows (src/js/pages/changelog.js). The exe has no git and
// players have no repo, so the entries ship as data. The source is the Discord update log's (scripts/discord-setup.mjs):
// every commit on the same branch, read the same way, on the day it was made. What differs is what players may read:
//   - scripts/data/changelog-notes.json is the reviewed wording: updates to hide, and subjects to show rewritten.
//   - A subject that isn't in there is shown as written if it passes the checks below, and held back if it doesn't, so a
//     new commit can't put an address, a file name or how the staff tools work in front of players.
// A version's updates end at the last commit built into it, which `npm run dist` records in
// scripts/data/changelog-versions.json; everything after the last one belongs to the version in package.json.
//
//   node scripts/build-changelog.mjs                 write the file (npm run dist does this, so an exe can't ship an old one)
//   node scripts/build-changelog.mjs --check [file]  fail if the file doesn't match what git says now
//   node scripts/build-changelog.mjs --release       write it, and record this version's last update
//   node scripts/build-changelog.mjs --report        list what's hidden, rewritten, held back and shown as written
// The file is generated, so git ignores it: a tracked copy would be stale after every commit, including its own.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS = path.join(ROOT, 'scripts/data/changelog-versions.json');
export const OUT = path.join(ROOT, 'src/data/changelog.json');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.resolve(ROOT, rel), 'utf8'));

// ---- the source: the update log's ----------------------------------------------------------------------------------
export function readCommits() {
  const branch = readJson('scripts/data/discord-server.json').updateLog?.branch || 'HEAD';
  const log = execFileSync('git', ['log', '--reverse', '--format=%at%x1f%ad%x1f%s', '--date=format:%Y-%m-%d', branch, '--'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
  return log.split('\n').filter(Boolean).map((l) => { const [at, day, subject] = l.split('\x1f'); return { at: +at, day, subject }; })
    .sort((a, b) => a.at - b.at);
}

// ---- what players may read -----------------------------------------------------------------------------------------
// Never in the game, however it got there: these fail the build if a reviewed note has one.
export const NEVER = [
  ['a web address', /https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|gg|app|dev|co|ai)\b|\blocalhost\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/i],
  ['a file name or path', /\b[\w-]+\.(?:[cm]?js|ts|json|css|html?|md|ya?ml|exe|dll|vpk|py|sh|bat|ps1|log|txt|sql)\b|\b(?:src|scripts|server|cs2|shared|dist|node_modules)\/\w/i],
  ['code', /(?:^|[\s(])\.[a-z][\w-]*|\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*|\b[a-z]+[A-Z][A-Za-z]*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|`/],
  ['a commit hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ['a commit trailer or author', /co-authored|signed-off|reviewed-by|noreply@|\bclaude\b|\banthropic\b/i],
];
// Held back unless a person has reviewed the wording: a note in changelog-notes.json may use these words on purpose.
export const REVIEW = [
  ['staff tools', /\b(?:admins?|staff|moderat\w+|ban\w*|audit\w*|discord)\b/i],
  ['accounts and secrets', /\b(?:tokens?|passwords?|secrets?|credentials?|api keys?|webhooks?)\b/i],
  ['how to exploit something', /\b(?:exploit\w*|dup(?:e|es|ed|ing|lication)|duplicat\w+|cheat\w*|hack\w*|bypass\w*|vulnerab\w*|injection|loophole\w*|glitch\w*|abus\w+|free money|for free|without paying|twice)\b/i],
  ['internal work', /\b(?:refactor\w*|deploy\w*|readme|lint\w*|wip|todo|fixme|tests?|smoke (?:tests?|runs?|checks?)|backend|frontend|server-side|keep-alive|database schema|migrations?)\b/i],
];
// Commits that aren't updates to the game at all: by their "Area:" prefix, or by what they open with.
const NOT_THE_GAME = /^(?:(?:admin(?: panel)?(?: offline)?|staff|moderation|discord(?: server(?: setup)?)?|smoke|deploy|ci|lint|chore|refactor|server|build)\b[^:]{0,20}:|(?:merge|revert|scripts?|tests?|smoke tests?|readme|docs?)\b)/i;

const hit = (rules, text) => rules.find(([, re]) => re.test(text))?.[0] || null;

export function loadNotes() {
  const { hide, rewrite } = readJson('scripts/data/changelog-notes.json');
  return { hidden: new Map(Object.entries(hide).flatMap(([why, list]) => list.map((s) => [s, why]))), rewrite };
}

// What becomes of a commit: { text } to show it, { hide } not to, and `held` when it's only the checks that stopped it.
export function classify(subject, notes) {
  if (notes.hidden.has(subject)) return { hide: notes.hidden.get(subject) };
  if (Object.hasOwn(notes.rewrite, subject)) {
    const text = notes.rewrite[subject], bad = hit(NEVER, text);
    if (bad) throw new Error(`A note in changelog-notes.json has ${bad} in it: ${text}`);
    return { text, rewritten: true };
  }
  if (NOT_THE_GAME.test(subject)) return { hide: 'not an update to the game' };
  const bad = hit(NEVER, subject) || hit(REVIEW, subject);
  return bad ? { hide: `held back: ${bad}`, held: true } : { text: subject };
}

// ---- how it reads --------------------------------------------------------------------------------------------------
// Subjects start "Area: what changed". The same areas under other names:
const AREA_NAMES = {
  'Play mode': 'Play', 'Play mode fixes': 'Play', 'Play maps': 'Play', 'Play bots': 'Play', 'Play offline': 'Play',
  'Case reel': 'Cases', 'Case opening': 'Cases', 'Charm pictures': 'Charms', 'Inspect backdrops': 'Inspect',
  'Item details': 'Items', 'Item Database offline': 'Item Database', 'Offline NPC players': 'NPCs', 'Friends chat': 'Friends',
  'Top bar': 'Menus', 'Panorama UI': 'Menus', 'CS2-style UI': 'Menus',
};
// With no prefix, the first of these it mentions.
const AREA_WORDS = [
  ['Play', /\bplay\b|\bbots?\b|\bmaps?\b/i], ['Charms', /\bcharms?\b/i], ['Gloves', /\bgloves?\b/i], ['Stickers', /\bstickers?\b/i],
  ['Inspect', /\binspects?\b|\bfirst[- ]person\b/i], ['Cases', /\bcases?\b|\bunbox/i], ['Market', /\bmarket\b/i], ['Inventory', /\binventory\b/i],
];

export function parse(line) {
  const m = /^([A-Z][^:;,]{0,40}?): +(.+)$/.exec(line.trim());
  const area = m ? AREA_NAMES[m[1]] || m[1] : AREA_WORDS.find(([, re]) => re.test(line))?.[0] || 'General';
  const text = m ? m[2] : line.trim();
  return { area, text: /^[a-z]+\b/.test(text) ? text[0].toUpperCase() + text.slice(1) : text };
}

// The file's contents, newest first. Each update has the version it shipped in, so the update window can ask for one
// version's updates. A pure function of its arguments: --check depends on that.
export function buildChangelog({ commits, notes, versions, version }) {
  const releases = Object.entries(versions).sort((a, b) => a[1] - b[1]);
  const versionOf = (at) => releases.find(([, through]) => at <= through)?.[0] ?? version;
  const updates = [];
  for (const c of commits) {
    const r = classify(c.subject, notes);
    if (r.text) updates.push({ at: c.at, day: c.day, version: versionOf(c.at), ...parse(r.text) });
  }
  return { version, updates: updates.reverse() };
}
export const serialize = (log) => `${JSON.stringify(log, null, 1)}\n`;

function current(commits) {
  return buildChangelog({ commits, notes: loadNotes(), versions: readJson('scripts/data/changelog-versions.json'), version: readJson('package.json').version });
}

function report(commits) {
  const notes = loadNotes(), lists = { hidden: [], 'held back': [], rewritten: [], 'as written': [] };
  for (const c of commits) {
    const r = classify(c.subject, notes);
    if (r.held) lists['held back'].push(`${c.subject}  [${r.hide.replace('held back: ', '')}]`);
    else if (r.hide) lists.hidden.push(`${c.subject}  [${r.hide}]`);
    else if (r.rewritten) lists.rewritten.push(`${c.subject}\n    -> ${r.text}`);
    else lists['as written'].push(c.subject);
  }
  for (const [name, list] of Object.entries(lists)) console.log(`\n== ${name} (${list.length}) ==\n${list.join('\n')}`);
  const subjects = new Set(commits.map((c) => c.subject));
  const unused = [...notes.hidden.keys(), ...Object.keys(notes.rewrite)].filter((s) => !subjects.has(s));
  if (unused.length) console.log(`\n== in changelog-notes.json but not in the log (${unused.length}) ==\n${unused.join('\n')}`);
}

function main(args) {
  const testBuild = !!process.env.CS2SIM_BUILD_DIR;
  let commits;
  try {
    commits = readCommits();
  } catch (e) {
    // A real build stops here. A test build may be from a snapshot with no git, and its changelog doesn't matter.
    if (!testBuild) { console.error(`changelog: can't read the git log, so the build stops rather than ship an old changelog.\n${e.message}`); process.exit(1); }
    console.warn('changelog: no git here (a test build): the changelog stays as it is.');
    if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, serialize({ version: readJson('package.json').version, updates: [] }));
    return;
  }
  if (args.includes('--report')) return report(commits);
  if (args.includes('--check')) {
    const file = args[args.indexOf('--check') + 1] || OUT;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === serialize(current(commits))) return console.log('changelog: up to date');
    console.error(`changelog: ${path.relative(ROOT, file)} is ${fs.existsSync(file) ? 'stale' : 'missing'}: run npm run changelog`);
    process.exit(1);
  }
  if (args.includes('--release') && commits.length) {
    const versions = readJson('scripts/data/changelog-versions.json');
    versions[readJson('package.json').version] = commits.at(-1).at;
    fs.writeFileSync(VERSIONS, `${JSON.stringify(versions, null, 2)}\n`);
  }
  const log = current(commits);
  fs.writeFileSync(OUT, serialize(log));
  console.log(`changelog: ${log.updates.length} of ${commits.length} updates, for version ${log.version}`);
  const notes = loadNotes(), held = commits.map((c) => [c.subject, classify(c.subject, notes)]).filter(([, r]) => r.held);
  for (const [subject, r] of held) console.warn(`changelog: ${r.hide}: ${subject}`);
  if (held.length) console.warn('changelog: to show one, give it a note in scripts/data/changelog-notes.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
