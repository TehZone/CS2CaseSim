// Passive income online: $100 for every whole minute, while the game is open and while it's closed, up to 12 hours of it at
// a time (the rule: engine/levels.js PASSIVE; what pays it: the action 'passive.collect'). Only the server's clock counts, and
// only the server collects: when a player connects (the time they were away, which the welcome tells them), then about
// every minute for everyone connected, from one timer for the whole server (it looks every few seconds and pays whoever has
// a whole minute due, so each player is paid on their own minute). A client can't ask for it or send a time.
//
// Why a minute can't be paid twice: the time it has been counted up to (passive.at) is in the account's state, and each
// collect moves it on by the minutes it paid in the same change as the money, under the player's lock (store.withUser).
// Money and that time are written together, and only if the database still has the money and the time this copy had
// (store.patch, one UPDATE ... WHERE): a copy that's out of date (two server instances running at once during a deploy,
// each with its own copy in memory) can't pay a minute the other one already paid, and doesn't write back its view of the
// rest of the row. After a restart the next collect pays from the saved time. Two windows are one account: one collect,
// sent to both.
import { makeCtx, runAction, delta } from '../src/js/engine/actions.js';
import { passiveDue } from '../src/js/engine/levels.js';

export const PASSIVE_TICK_MS = 10 * 1000;
const FIELDS = ['money', 'passive']; // (what 'passive.collect' changes: all a collect writes by itself)

// Collects one player's passive income at `now`, the caller holding their lock (entry `e` from the store). → { r, d } (d:
// the change, only money and the clock, the push kept small) or null when nothing was due.
//
// Written by itself: only those two fields, and only if the database still has them as this copy had them (store.patch). A
// timer writing whole rows would put back each connected player's copy of everything else, which, while two instances run
// at once, the other one may have changed since (a trade, a payout, a staff edit). If it has, this copy is out of date: it's
// put back as it was, read again from the database and collected from there (once). Written with the whole row instead when
// that's on its way anyway (a change of the player's own on this server not written yet, or being written), or when the
// clock starts (an account from before passive income: once).
export async function collectIn(store, e, now, again = true) {
  if (!passiveDue(e.st.passive, now)) return null;
  const was = { money: e.st.money, passive: e.st.passive };
  const ctx = makeCtx(e.st, { online: true, system: true, now });
  const r = runAction(ctx, 'passive.collect');
  const { set } = delta(ctx);
  if (e.dirty || e.saving || !Number.isFinite(was.passive?.at) || Object.keys(set).some((k) => !FIELDS.includes(k))) {
    store.markDirty(e);
    return { r, d: { set } };
  }
  if (await store.patch(e, was, set)) return { r, d: { set } };
  e.st.money = was.money;
  e.st.passive = was.passive;
  if (!again) { store.cache.delete(e.id); return null; } // (changed again meanwhile: read afresh next time)
  await store.reload(e);
  return collectIn(store, e, now, false);
}
// The same, taking their lock; the time is read once it's held.
export const collect = (store, id, clock = Date.now) => store.withUser(id, async (e) => collectIn(store, e, clock()));

export class Passive {
  // srv: the server's { store, sockets, sendTo, log }. clock: the server's time (tests set their own); tick: how often it looks.
  constructor(srv, { clock = Date.now, tick = PASSIVE_TICK_MS } = {}) {
    this.srv = srv;
    this.clock = clock;
    this.busy = false;
    this.timer = setInterval(() => this.round().catch((e) => srv.log('[passive] round failed', e?.message || e)), tick);
    this.timer.unref?.();
  }

  // A player connecting (the caller holds their lock): the time since they were last paid, at most 12 hours of it. (Async: by
  // the time it's done, `e` may have been read again from the database: collectIn.)
  connected(e) {
    return collectIn(this.srv.store, e, this.clock());
  }

  // Sends to a player's windows that have had their welcome (ws.welcomed, server/index.mjs). One still saying hello gets the
  // change in its welcome's state, and a change before that would land on the game's offline save instead.
  push(id, msg, except = null) {
    const text = JSON.stringify(msg);
    for (const ws of this.srv.sockets.get(id) || []) if (ws !== except && ws.welcomed && ws.readyState === 1) ws.send(text);
  }

  // Everyone connected with a whole minute due, once each however many windows they have open. Not a player whose only
  // window is still saying hello: its welcome pays the time away. (A quick look first without the lock: most rounds have
  // nobody due.)
  async round() {
    if (this.busy) return;
    this.busy = true;
    const { store, sockets } = this.srv;
    try {
      await Promise.all([...sockets.entries()].map(async ([id, set]) => {
        if (![...set].some((ws) => ws.welcomed)) return;
        const e = store.cache.get(id);
        if (e && !passiveDue(e.st.passive, this.clock())) return;
        try {
          const out = await collect(store, id, this.clock);
          if (out) this.push(id, { t: 'delta', d: out.d });
        } catch (err) { this.srv.log('[passive] collect failed', id, err?.message || err); }
      }));
    } finally {
      this.busy = false;
    }
  }

  close() {
    clearInterval(this.timer);
  }
}
