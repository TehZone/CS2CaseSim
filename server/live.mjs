// Live gambling between players: coinflip lobbies, one shared jackpot pot and case battle lobbies.
// Stakes are taken from the player and kept in escrow (a row in `rounds`) until the round settles, in the same
// database transaction, so a crash or restart can never lose or duplicate them: open rounds are refunded at start.
import crypto from 'node:crypto';
import { D } from '../src/js/engine/data.js';
import { makeCtx, delta, give, credit, spend, takeStake, atomically, GameError } from '../src/js/engine/actions.js';
import { itemValue, serialKey } from '../src/js/engine/items.js';
import * as G from '../src/js/engine/gamble.js';
import { round2 } from '../src/js/engine/util.js';

const fail = (m) => { throw new GameError(m); };
const JACKPOT_MS = +process.env.JACKPOT_MS || 45000;
const seedOf = (s) => String(s || '').slice(0, 64) || G.newSeed().slice(0, 16);

export class Live {
  constructor(srv) {
    this.srv = srv;
    this.flips = new Map();
    this.battles = new Map();
    this.pot = null;
    this.timer = setInterval(() => this.tick().catch((e) => srv.log('[live] tick', e.message)), 1000);
  }

  // ---- escrow persistence ----------------------------------------------------------------------------
  async saveRound(q, round, status = 'open') {
    const now = Date.now();
    await q(`INSERT INTO rounds (id, kind, status, data, created, updated) VALUES ($1, $2, $3, $4::jsonb, $5, $5)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated = EXCLUDED.updated`,
    [round.id, round.kind, status, JSON.stringify(round), now]);
  }

  // Refunds every round that was still open when the server stopped.
  async refundOpen() {
    const { rows } = await this.srv.db.query("SELECT * FROM rounds WHERE status = 'open'");
    for (const r of rows) {
      const round = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      const ids = Object.keys(round.escrow || {}).map(Number);
      await this.srv.store.lock(ids, async (entries) => {
        for (const e of entries) {
          const esc = round.escrow[e.id];
          const ctx = makeCtx(e.st, { online: true });
          if (esc.cash) credit(ctx, esc.cash);
          if (esc.items?.length) give(ctx, esc.items);
        }
        await this.srv.store.commit(entries, (q) => this.saveRound(q, round, 'refunded'));
      });
      this.srv.log(`[live] refunded open ${round.kind} ${round.id} to ${ids.length} player(s)`);
    }
  }

  // Takes a stake (money and/or items) from a player into a round's escrow.
  async escrow(user, round, stakeArgs, extraCheck) {
    return this.srv.store.withUser(user.id, async (e) => {
      const ctx = makeCtx(e.st, { online: true, reserved: this.srv.trades.reserved(user.id) });
      const stake = atomically(ctx, () => {
        const s = stakeArgs.cost != null ? (spend(ctx, stakeArgs.cost), { cash: stakeArgs.cost, items: [], value: stakeArgs.cost }) : takeStake(ctx, stakeArgs);
        extraCheck?.(s);
        return s;
      });
      const prev = round.escrow[user.id] || { cash: 0, items: [] };
      round.escrow[user.id] = { cash: round2(prev.cash + stake.cash), items: [...prev.items, ...stake.items] };
      e.st.stats.gambleWagered = round2((e.st.stats.gambleWagered || 0) + stake.value);
      ctx.dirty.add('stats');
      await this.srv.store.commit([e], (q) => this.saveRound(q, round));
      this.srv.deltaTo(user.id, delta(ctx));
      return stake;
    });
  }

  // Pays out a settled round: winnings[userId] = { cash, items }, plus net results for the stats.
  async settle(round, winnings, status = 'settled') {
    const ids = [...new Set([...Object.keys(round.escrow), ...Object.keys(winnings)].map(Number))];
    const deltas = {};
    await this.srv.store.lock(ids, async (entries) => {
      for (const e of entries) {
        const ctx = makeCtx(e.st, { online: true });
        const w = winnings[e.id];
        if (w?.cash) credit(ctx, w.cash);
        if (w?.items?.length) give(ctx, w.items.map((it) => ({ ...it, nw: true })));
        const staked = round.escrow[e.id] ? round.escrow[e.id].cash + round.escrow[e.id].items.reduce((s, it) => s + itemValue(it), 0) : 0;
        const won = w ? (w.cash || 0) + (w.items || []).reduce((s, it) => s + itemValue(it), 0) : 0;
        e.st.stats.gambleWon = round2((e.st.stats.gambleWon || 0) + won - staked);
        ctx.dirty.add('stats');
        deltas[e.id] = delta(ctx);
      }
      await this.srv.store.commit(entries, (q) => this.saveRound(q, round, status));
    });
    for (const [id, d] of Object.entries(deltas)) this.srv.deltaTo(+id, d);
  }

  // ---- what each player sees -----------------------------------------------------------------------
  snapshot(userId) {
    return {
      flips: [...this.flips.values()].map((f) => ({ id: f.id, name: f.name, side: f.side, value: f.value, items: f.itemCount, hash: f.fair.hash, mine: f.userId === userId })),
      battles: [...this.battles.values()].map((b) => ({
        id: b.id, format: b.format, mode: b.mode, cases: b.cases, cost: b.cost, hash: b.fair.hash, mine: b.creator === userId,
        seats: b.seats.map((s) => (s ? { name: s.name, bot: !!s.bot } : null)),
      })),
      jackpot: this.pot ? {
        hash: this.pot.fair.hash, endsAt: this.pot.endsAt, total: this.pot.total,
        entries: this.pot.entries.map((x) => ({ id: x.userId === userId ? 'me' : 'u' + x.userId, name: x.name, value: x.value, color: x.color })),
      } : null,
    };
  }
  broadcast() { this.srv.forEachOnline((id) => this.srv.sendTo(id, { t: 'lobbies', lobbies: this.snapshot(id) })); }

  async rpc(user, m, a = {}) {
    const r = await this.dispatch(user, m, a);
    this.broadcast();
    return r;
  }
  async dispatch(user, m, a) {
    switch (m) {
      // ---- coinflip ----
      case 'flip.create': {
        if (!G.SIDES.includes(a.side)) fail('Pick CT or T');
        if ([...this.flips.values()].filter((f) => f.userId === user.id).length >= 3) fail('You can have 3 open coinflips at most');
        const fair = G.newFairness(seedOf(a.clientSeed));
        const round = { id: crypto.randomUUID(), kind: 'flip', escrow: {}, fair };
        const stake = await this.escrow(user, round, { money: a.money, uids: a.uids || [] });
        this.flips.set(round.id, { ...round, userId: user.id, name: user.name, side: a.side, value: stake.value, itemCount: stake.items.length, seeds: [fair.clientSeed] });
        return { id: round.id, hash: fair.hash };
      }
      case 'flip.cancel': {
        const f = this.flips.get(String(a.id));
        if (!f || f.userId !== user.id) fail('That coinflip is gone');
        this.flips.delete(f.id);
        await this.settle(f, { [user.id]: f.escrow[user.id] }, 'cancelled');
        return {};
      }
      case 'flip.join': {
        const f = this.flips.get(String(a.id));
        if (!f) fail('That coinflip is gone');
        if (f.userId === user.id) fail('You can’t join your own coinflip');
        this.flips.delete(f.id); // nobody else can join while this one is processed
        try {
          await this.escrow(user, f, { money: a.money, uids: a.uids || [] }, (stake) => {
            if (stake.value < f.value * 0.95 - 1e-9 || stake.value > f.value * 1.05 + 1e-9) fail(`Your stake must be between ${(f.value * 0.95).toFixed(2)} and ${(f.value * 1.05).toFixed(2)}`);
          });
        } catch (e) { this.flips.set(f.id, f); throw e; }
        f.seeds.push(seedOf(a.clientSeed));
        return this.finishFlip(f, { id: user.id, name: user.name });
      }
      case 'flip.bot': {
        const f = this.flips.get(String(a.id));
        if (!f || f.userId !== user.id) fail('That coinflip is gone');
        this.flips.delete(f.id);
        return this.finishFlip(f, null);
      }
      // ---- jackpot ----
      case 'jackpot.join': {
        if (!this.pot) this.pot = { id: crypto.randomUUID(), kind: 'jackpot', escrow: {}, fair: G.newFairness(''), entries: [], total: 0, endsAt: null, seeds: [] };
        const pot = this.pot;
        if (pot.endsAt && pot.endsAt - Date.now() < 3000) fail('The draw is about to happen. Join the next pot.');
        if (pot.entries.length >= 30) fail('This pot is full');
        const stake = await this.escrow(user, pot, { money: a.money, uids: a.uids || [] }, (s) => { if (s.value < 0.1) fail('The minimum is $0.10'); });
        const prev = pot.entries.find((x) => x.userId === user.id);
        if (prev) prev.value = round2(prev.value + stake.value);
        else pot.entries.push({ userId: user.id, name: user.name, value: stake.value, color: `hsl(${(user.id * 67) % 360} 60% 45%)` });
        pot.total = round2(pot.total + stake.value);
        pot.seeds.push(seedOf(a.clientSeed));
        if (!pot.endsAt && pot.entries.length >= 2) pot.endsAt = Date.now() + JACKPOT_MS;
        await this.srv.db.tx((q) => this.saveRound(q, pot)); // keep the escrow row's entries current
        return { total: pot.total };
      }
      // ---- case battles ----
      case 'battle.create': {
        const f = G.BATTLE_FORMATS[a.format];
        if (!f) fail('Unknown format');
        if (!G.BATTLE_MODES[a.mode]) fail('Unknown mode');
        const cases = Array.isArray(a.cases) ? a.cases.map(String) : [];
        if (!cases.length || cases.length > G.MAX_BATTLE_ROUNDS || cases.some((id) => D.caseById[id]?.price == null)) fail('Pick valid cases');
        if ([...this.battles.values()].filter((b) => b.creator === user.id).length >= 3) fail('You can have 3 open battles at most');
        const cost = G.battleCost(cases);
        const round = { id: crypto.randomUUID(), kind: 'battle', escrow: {}, fair: G.newFairness('') };
        await this.escrow(user, round, { cost });
        this.battles.set(round.id, { ...round, creator: user.id, format: a.format, mode: a.mode, cases, cost, seats: [{ userId: user.id, name: user.name }, ...Array(f.seats - 1).fill(null)], seeds: [seedOf(a.clientSeed)] });
        return { id: round.id, hash: round.fair.hash };
      }
      case 'battle.join': {
        const b = this.battles.get(String(a.id));
        if (!b) fail('That battle is gone');
        const seat = Number(a.seat);
        if (!Number.isInteger(seat) || seat < 0 || seat >= b.seats.length || b.seats[seat]) fail('That seat is taken');
        if (b.seats.some((s) => s?.userId === user.id)) fail('You are already in this battle');
        b.seats[seat] = { userId: user.id, name: user.name };
        try { await this.escrow(user, b, { cost: b.cost }); } catch (e) { b.seats[seat] = null; throw e; }
        b.seeds.push(seedOf(a.clientSeed));
        if (b.seats.every(Boolean)) await this.runBattle(b);
        return {};
      }
      case 'battle.bots': {
        const b = this.battles.get(String(a.id));
        if (!b || b.creator !== user.id) fail('That battle is gone');
        b.seats = b.seats.map((s, i) => s || { bot: true, ...G.botPlayer(b.fair.hash.slice(0, 6) + i) });
        await this.runBattle(b);
        return {};
      }
      case 'battle.cancel': {
        const b = this.battles.get(String(a.id));
        if (!b || b.creator !== user.id) fail('That battle is gone');
        if (b.seats.some((s) => s && !s.bot && s.userId !== user.id)) fail('Other players have joined; it can’t be cancelled now');
        this.battles.delete(b.id);
        await this.settle(b, { [user.id]: b.escrow[user.id] }, 'cancelled');
        return {};
      }
    }
    fail('Unknown request');
  }

  async finishFlip(f, opponent) {
    const fair = { ...f.fair, clientSeed: f.seeds.join('-') };
    const result = G.coinflipResult(fair.serverSeed, fair.clientSeed);
    const creatorWins = result === f.side;
    const pot = Object.values(f.escrow);
    let winnings = {};
    let winnerName;
    if (creatorWins) {
      // The creator gets everything; against a bot the bot's matching stake is paid in money.
      winnings[f.userId] = { cash: round2(pot.reduce((s, x) => s + x.cash, 0) + (opponent ? 0 : f.value)), items: pot.flatMap((x) => x.items) };
      winnerName = f.name;
    } else if (opponent) {
      winnings[opponent.id] = { cash: round2(pot.reduce((s, x) => s + x.cash, 0)), items: pot.flatMap((x) => x.items) };
      winnerName = opponent.name;
    } else winnerName = G.botPlayer(f.fair.hash.slice(0, 8)).name;
    await this.settle(f, winnings);
    const value = round2(Object.values(f.escrow).reduce((s, x) => s + x.cash + x.items.reduce((t, it) => t + itemValue(it), 0), 0) + (opponent ? 0 : f.value));
    const res = { result, side: f.side, value, fair, winnerName };
    this.srv.sendTo(f.userId, { t: 'gamble.result', ev: { kind: 'flip', won: creatorWins, result: res } });
    if (opponent) this.srv.sendTo(opponent.id, { t: 'gamble.result', ev: { kind: 'flip', won: !creatorWins, result: res } });
    return { result, won: opponent ? !creatorWins : creatorWins };
  }

  async runBattle(b) {
    this.battles.delete(b.id);
    const fair = { ...b.fair, clientSeed: b.seeds.join('-') };
    const res = G.runBattle({ cases: b.cases, format: b.format, mode: b.mode }, fair, itemValue);
    const winnings = {};
    for (const seat of res.winners) {
      const s = b.seats[seat];
      if (s && !s.bot) {
        for (const it of res.share[seat]) it.sn = this.srv.serial(serialKey(it)); // unboxed in the battle
        winnings[s.userId] = { cash: 0, items: res.share[seat] };
      }
    }
    await this.settle(b, winnings);
    const seats = b.seats.map((s) => ({ name: s.name, bot: !!s.bot, avatar: s.avatar || '', color: s.color || '' }));
    const result = { ...res, seats, fair, cases: b.cases, format: b.format, mode: b.mode, cost: b.cost };
    b.seats.forEach((s, i) => { if (s && !s.bot) this.srv.sendTo(s.userId, { t: 'gamble.result', ev: { kind: 'battle', result, mySeat: i } }); });
    for (const s of b.seats) if (s && !s.bot) this.srv.bumpStat(s.userId, 'battles');
  }

  async tick() {
    const pot = this.pot;
    if (!pot?.endsAt || Date.now() < pot.endsAt || pot.drawing) return;
    pot.drawing = true;
    const fair = { ...pot.fair, clientSeed: pot.seeds.join('-') };
    const entries = pot.entries.map((x) => ({ id: x.userId, value: x.value }));
    const { winner } = G.jackpotWinner(entries, fair.serverSeed, fair.clientSeed);
    const all = Object.values(pot.escrow);
    const winnings = { [winner]: { cash: round2(all.reduce((s, x) => s + x.cash, 0)), items: all.flatMap((x) => x.items) } };
    this.pot = null;
    await this.settle(pot, winnings);
    const winnerName = pot.entries.find((x) => x.userId === winner).name;
    for (const x of pot.entries) {
      const view = pot.entries.map((y) => ({ id: y.userId === x.userId ? 'me' : 'u' + y.userId, name: y.name, value: y.value, color: y.color }));
      this.srv.sendTo(x.userId, { t: 'gamble.result', ev: { kind: 'jackpot', won: x.userId === winner, result: { entries: view, total: pot.total, winner: winner === x.userId ? 'me' : 'u' + winner, winnerName, fair } } });
    }
    this.broadcast();
  }

  close() { clearInterval(this.timer); }
}
