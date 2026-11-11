// The game's offline side, as the real modules run it (with the real state and game data; the page's globals are
// stand-ins and nothing goes on the network): the admin panel offline is every player's, for their own offline save,
// and never acts while online (admin-local.js).
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
const { freshState } = await import('../src/js/engine/economy.js');
const DATA = new URL('../src/data/', import.meta.url);
initData(JSON.parse(fs.readFileSync(new URL('game-data.json', DATA), 'utf8')), { keys: JSON.parse(fs.readFileSync(new URL('keys.json', DATA), 'utf8')) });

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const refusal = async (p) => { try { await p; return null; } catch (e) { return e; } };

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
} finally {
  console.warn = quiet;
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
