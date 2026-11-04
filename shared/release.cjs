// What a release of the game is, for the game's updater (shared/updater.cjs), the server's version lock
// (server/release.mjs) and the build (scripts/build-exe.mjs): versions, compared number by number, and latest.json, the
// file every GitHub release carries beside its two exes:
//   { version: '1.1.0', date, notes, files: { installer: { name, size, sha256 }, portable: { name, size, sha256 } } }
// It's read from the release's files and not from GitHub's REST API, which allows 60 requests an hour per address:
// players behind one address, or Render's shared ones, could use that up. `latest` is the newest published release, so
// a draft or a prerelease changes nothing until it's published.
'use strict';

const REPO = 'TehZone/CS2CaseSim';
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
const RELEASE_FILES = `${RELEASE_PAGE}/download`;
const RELEASE_FEED = `${RELEASE_FILES}/latest.json`;
const MANIFEST = 'latest.json';
const FILE_KINDS = { installer: 'CS2-Case-Simulator-Setup.exe', portable: 'CS2-Case-Simulator.exe' };

// [major, minor, patch] (numbers, so 1.10.0 is after 1.9.0), or null for anything else: a prerelease, garbage, nothing.
function parseVersion(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

// -1, 0 or 1. Something that isn't a version comes before every version.
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// A client's version against the one required (none required: nobody is outdated). No version counts as outdated.
const isOutdated = (version, required) => !!parseVersion(required) && compareVersions(version, required) < 0;

// latest.json as sent, checked, or null. A release nobody could update to (no valid file) isn't a release here.
function parseManifest(m) {
  if (!m || typeof m !== 'object' || !parseVersion(m.version)) return null;
  const files = {};
  for (const kind of Object.keys(FILE_KINDS)) {
    const f = m.files?.[kind];
    if (!f || typeof f.name !== 'string' || !/^[\w.-]{1,100}$/.test(f.name) || /^\.+$/.test(f.name)) continue;
    if (!Number.isSafeInteger(f.size) || f.size <= 0 || !/^[0-9a-f]{64}$/i.test(String(f.sha256))) continue;
    files[kind] = { name: f.name, size: f.size, sha256: f.sha256.toLowerCase() };
  }
  if (!Object.keys(files).length) return null;
  return {
    version: m.version.trim().replace(/^v/, ''),
    date: typeof m.date === 'string' ? m.date.slice(0, 40) : '',
    notes: typeof m.notes === 'string' ? m.notes.trim().slice(0, 4000) : '',
    files,
  };
}

// What a refused game shows. Plain text with the address written out: exes from before the updater show this and nothing
// else, in a toast or under the login form.
const outdatedText = (required) => `Your game is out of date, so you can't play online with other players. Version ${required} is out: get it from ${RELEASE_PAGE}`;

module.exports = { REPO, RELEASE_PAGE, RELEASE_FILES, RELEASE_FEED, MANIFEST, FILE_KINDS, parseVersion, compareVersions, isOutdated, parseManifest, outdatedText };
