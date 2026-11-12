// Passive income in the game (the rule: engine/levels.js PASSIVE): $100 every minute and $100 more for each prestige (each
// Service Medal), even while the game is closed, up to 12 hours of it at a time. Offline the save collects it as the game loads and then every minute while it runs, by this PC's
// clock (the action 'passive.collect'); online the server pays it by its own clock (server/passive.mjs) and its welcome says
// what your time away paid. A collect that paid for time away gets one toast; the minute-by-minute ones only put the money
// up.
import { act, online } from './backend.js';
import { S } from './state.js';
import { net } from './net/online.js';
import { toast } from './ui.js';
import { money } from './util.js';
import { round2 } from './engine/util.js';
import { PASSIVE, passiveDue } from './engine/levels.js';

// A collect of more minutes than this was time away (while the game runs, each one is a minute, now and then two).
const AWAY_MINUTES = 3;
const LOOK_MS = 10 * 1000; // (how often the game looks for a whole minute due)
const TOAST_MS = 6000;

const capText = (r) => (r.capped ? ` (${PASSIVE.capHours} hours max)` : '');
const awayText = (r) => `While you were away you earned <b class="green">${money(r.earned)}</b>${capText(r)}`;
const backText = (r) => `Your offline save earned <b class="green">${money(r.earned)}</b> while you were away from it${capText(r)}`;
const worth = (r) => r?.minutes >= AWAY_MINUTES && r.earned > 0;
const say = (r, text) => { if (worth(r)) toast(text(r), 'gold', TOAST_MS); };
// Two collects told as one.
const sum = (a, b) => (!a ? b : !b ? a : { earned: round2(a.earned + b.earned), minutes: a.minutes + b.minutes, capped: !!(a.capped || b.capped) });

// What the offline save was paid for time away and hasn't said yet. held: paid while the game was connecting (with the
// minutes after it until it's said), said once that attempt fails (you're on the offline save meanwhile), or kept in owed if
// it goes online (the welcome says the account's own time away). owed: said with what the offline save earns meanwhile,
// when you're back on it.
let held = null, owed = null;

// The offline save's passive income, when a minute is due (online the server pays it). → the collect's result, or null.
async function collect() {
  if (online() || !passiveDue(S.passive, Date.now())) return null;
  return act('passive.collect');
}
function look() {
  collect().then((r) => {
    if (r && net.status() === 'connecting' && (held || worth(r))) held = sum(held, r);
    else say(r, awayText);
  }).catch((e) => console.warn('passive income', e));
}

// Once the save is loaded, and after net.resume(): a connection on its way holds back the offline save's toast.
export function initPassive() {
  look();
  setInterval(look, LOOK_MS);
  net.on('away', (r) => say(r, awayText));
  let wasOnline = false;
  net.on('status', ({ status, lost }) => {
    if (status === 'online') { owed = sum(owed, held); held = null; wasOnline = true; return; }
    // The attempt on its way failed (the game tries again), or it's offline, and still on the offline save: what it was paid.
    if ((lost || status === 'offline') && !online()) { say(held, awayText); held = null; }
    if (status !== 'offline' || !wasOnline) return;
    // Back on the offline save: what it earned meanwhile, with what it was paid as the game went online.
    wasOnline = false;
    collect().then((r) => { const all = sum(owed, r); owed = null; say(all, backText); }).catch((e) => console.warn('passive income', e));
  });
}
