// Team play for the bots, like players at their ranks. Each round: the economy call (save, force, full buy) and a plan,
// called by the team's best player in the chat. Terrorists rush a site, execute one with lineups (smokes, then molotovs,
// then pop flashes as the entry goes in), take mid and split, or play a default for picks and hit a site later, with time
// left to plant (a rush or a default by any of the site's ways in, not always the shortest from their spawn); each bot
// has a role (entry, support with the utility, lurker, AWPer). Counter-terrorists split up over the sites (stacking the
// one that keeps getting hit, at higher ranks; now and then one pushing out early for a pick), throw their early utility
// at the chokes, rotate on information and retake together. On the maps setups.js knows, each CT plays a real position
// on its site (jungle, stairs, ticket booth...), and a terrorists' default spreads over the real map control (top mid,
// palace, ramp, apps...). The brains (ai.js) play their part of it.
import { lineupsFor, nadeFor } from './utility.js';
import { setupOf } from './setups.js';

const rnd = () => Math.random();
const pick = (a) => a[Math.floor(rnd() * a.length)];
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const PHASE = { smoke: 0, fire: 1, he: 1, flash: 2 };
// One of a list, the first ones the more often (the usual positions, then the alternatives).
const pickUsual = (list) => {
  let r = rnd() * list.reduce((s, _, i) => s + 1 / (i + 1), 0);
  for (let i = 0; i < list.length; i++) if ((r -= 1 / (i + 1)) <= 0) return list[i];
  return list[list.length - 1];
};
const isAwp = (b) => /awp|ssg08|scar20|g3sg1/.test(b.weapons.primary?.id || '');

export const teamSkill = (bots) => avg(bots.map((b) => b.c.skill ?? 0.42));
// The chance a CT side has one player pushing out early in a round (see teamPlan).
export const AGGRO = 0.4;
// Your own side's spawn (the game's enemySpawnCenter is named for who it's the enemy of).
export const ownSpawn = (game, side) => game.enemySpawnCenter(side === 'T' ? 'CT' : 'T');

// The round's buy for a side: 'pistol' | 'eco' | 'force' | 'full'. Lower ranks force more and save less.
export function teamEconomy(game, side, pistol) {
  if (pistol) return 'pistol';
  const m = game.match, r = m.rules, team = game.combatants.filter((c) => c.team === side);
  const money = avg(team.map((c) => c.money)), skill = teamSkill(game.bots.filter((b) => b.c.team === side));
  const lastOfHalf = m.round === r.halftime || m.round === r.maxRounds;
  const matchPoint = Math.max(m.score.A || 0, m.score.B || 0) >= r.winsNeeded - 1;
  if (money >= 3900) return 'full';
  if (money >= 3100 && rnd() < 0.5) return 'full'; // a lighter full buy
  if (money >= 2000 && (lastOfHalf || matchPoint || (m.lossStreak?.[side] || 0) >= 3 || rnd() < 0.55 - skill * 0.45)) return 'force';
  return 'eco';
}

// Where a side gathers before going onto a site: about 650 units short of it, on the way in from their spawn.
export function stagingPoint(game, site, side = 'T') {
  game.staging ||= {};
  const key = side + site;
  if (!game.staging[key]) {
    const box = game.map.info.bombsites.find((s) => s.site === site);
    if (!box) return ownSpawn(game, side);
    const to = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.min[2]];
    const pts = game.nav.path(ownSpawn(game, side), to)?.points || [];
    let pt = pts[0] || to, run = 0;
    for (let i = pts.length - 1; i > 0; i--) {
      run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (run >= 650) { pt = pts[i - 1]; break; }
    }
    game.staging[key] = [pt[0], pt[1], pt[2]];
  }
  return game.staging[key];
}

// Who throws which of a side's lineups for these purposes: smokes first, each to a bot that has the grenade (not the
// entry or the lurker), and only if the bot bothers at its rank (Silvers rarely do, Global Elites always).
function assignThrows(game, bots, side, purposes, roles) {
  const want = purposes.flatMap((p) => lineupsFor(game.lineups, side, p)).filter((l, i, a) => a.findIndex((x) => x.id === l.id) === i)
    .sort((x, y) => PHASE[x.kind] - PHASE[y.kind]);
  const load = new Map(), throws = [];
  for (const l of want) {
    const nade = nadeFor(l.kind, side);
    const by = bots.filter((b) => (b.c.nades[nade] || 0) > (load.get(b.c)?.[nade] || 0) && !['entry', 'lurk'].includes(roles?.get(b.c)))
      .sort((a, b) => (load.get(a.c)?.n || 0) - (load.get(b.c)?.n || 0) || Math.hypot(a.pos[0] - l.pos[0], a.pos[1] - l.pos[1]) - Math.hypot(b.pos[0] - l.pos[0], b.pos[1] - l.pos[1]))[0];
    if (!by || rnd() > by.brain.d.utility) continue;
    const lo = load.get(by.c) || { n: 0 };
    lo.n++; lo[nade] = (lo[nade] || 0) + 1;
    load.set(by.c, lo);
    throws.push({ lineup: l, by: by.c, nade, phase: PHASE[l.kind], done: false });
  }
  return throws;
}

// A round's plan for a side (econ: teamEconomy's call). Bots read plan.site, plan.roles, plan.throws, plan.stage...
export function teamPlan(game, side, econ = 'full') {
  const bots = game.bots.filter((b) => b.c.team === side);
  const sites = game.map.info.bombsites.map((s) => s.site);
  const skill = teamSkill(bots);
  const igl = bots.slice().sort((a, b) => (b.c.skill ?? 0) - (a.c.skill ?? 0))[0]?.c || null;
  if (side === 'T') {
    let strat;
    if (econ === 'eco') strat = rnd() < 0.65 ? 'rush' : 'default';
    else if (skill < 0.3) strat = rnd() < 0.6 ? 'rush' : 'default';
    else if (skill < 0.55) strat = pick(['rush', 'exec', 'exec', 'default', 'default']);
    else strat = pick(['exec', 'exec', 'exec', 'default', 'default', 'split', 'rush']);
    if (strat === 'split' && !game.midSpot) strat = 'exec';
    if (game.forceStrat) strat = game.forceStrat; // (a test drill: CS2SIM_SMOKE_DRILL)
    // The site: higher ranks don't keep hitting the same one.
    let site = pick(sites.length ? sites : ['A']);
    if (game.lastTSite && sites.length > 1 && rnd() < 0.25 + skill * 0.45) site = sites.find((s) => s !== game.lastTSite) || site;
    game.lastTSite = site;
    const roles = new Map();
    const awp = bots.find((b) => b.weapons.primary?.id === 'weapon_awp');
    if (awp) roles.set(awp.c, 'awp');
    const riflers = bots.filter((b) => !roles.has(b.c)).sort((a, b) => (b.c.skill ?? 0) - (a.c.skill ?? 0));
    const entry = riflers.find((b) => !b.c.hasC4) || riflers[0];
    if (entry) roles.set(entry.c, 'entry');
    if ((strat === 'default' || strat === 'split') && bots.length >= 4) {
      const lurk = riflers.filter((b) => !roles.has(b.c) && !b.c.hasC4).pop();
      if (lurk) roles.set(lurk.c, 'lurk');
    }
    for (const b of bots) if (!roles.has(b.c)) roles.set(b.c, 'support');
    const throws = strat === 'rush' ? [] : assignThrows(game, bots, 'T', strat === 'split' ? [site, 'mid'] : strat === 'default' ? [site, 'default'] : [site], roles);
    // A default's map control utility (a smoke for mid, say) goes out at the start, not with the hit.
    if (strat === 'default') for (const x of throws) x.early = x.lineup.purpose.includes('default') && !x.lineup.purpose.includes(site);
    // A default's spread: each on a real position (setups.js): the lurker on the other site's side, the entry in mid,
    // the rest over the others, one a part of the map before two.
    const positions = new Map(), spread = strat === 'default' && setupOf(game)?.T;
    if (spread) {
      const left = spread.slice().sort(() => rnd() - 0.5), take = (ok) => { const i = left.findIndex(ok); return i < 0 ? null : left.splice(i, 1)[0]; };
      const order = bots.slice().sort((a, b) => (roles.get(b.c) === 'lurk') - (roles.get(a.c) === 'lurk') || (roles.get(b.c) === 'entry') - (roles.get(a.c) === 'entry'));
      for (const b of order) {
        const role = roles.get(b.c), used = new Set([...positions.values()].map((p) => p.site));
        const p = (role === 'lurk' && take((x) => x.site !== site && x.site !== 'mid')) || (role === 'entry' && take((x) => x.site === 'mid'))
          || take((x) => !used.has(x.site)) || take(() => true);
        if (p) positions.set(b.c, p);
      }
    }
    // The way in: a rush or a default comes in by any of the site's ways (from their spawn, through mid, from the other
    // site: see spots.js), not always the shortest; an execute by the one its lineups are thrown for.
    const ways = game.spots?.place('hold:' + site)?.ways.length || 0;
    const route = (strat === 'rush' || strat === 'default') && ways > 1 ? Math.floor(rnd() * ways) : 0;
    const via = route ? game.spots.door(site, route) : null, from = route ? game.spots.place('hold:' + site).ways[route].from : null;
    // When it goes (seconds left on the clock): a rush at once; an execute once they've gathered; a default after its
    // half minute or so of map control, with time left to plant and play the bomb (not at the death).
    const execAt = strat === 'rush' ? 999 : strat === 'default' ? 50 + rnd() * 20 : strat === 'split' ? 65 + rnd() * 15 : 80 + rnd() * 15;
    const by = from === 'mid' ? ' through mid' : from ? ` from ${from}` : '';
    const call = { rush: `Rush ${site}${by}, don't stop!`, exec: `Execute ${site}: smokes, then flashes, then we go`, default: `Default. Play for picks, we hit ${site}${by} late`,
      split: `Split ${site}: two through mid, the rest with me` }[strat] + (econ === 'eco' ? ' (saving: pistols only)' : econ === 'force' ? ' (force buy)' : '');
    return { side, strat, site, roles, igl, throws, execAt, econ, call, positions, stage: strat === 'rush' ? 'execute' : strat === 'default' ? 'setup' : 'gather', execStart: strat === 'rush' ? 0 : null,
      lurk: [...roles].find(([, r]) => r === 'lurk')?.[0] || null, rush: strat === 'rush', route, via, staging: route ? game.spots.staging(site, route) : null };
  }
  // CT: the split (two, one, two with five), stacking the site the terrorists keep hitting at higher ranks.
  const assign = new Map();
  const order = bots.map((b) => b.c).sort(() => rnd() - 0.5);
  const n = order.length;
  const two = sites.includes('B') ? 'B' : sites[0] || 'A', one = sites.includes('A') ? 'A' : two; // (Wingman's one site, A or B, is both)
  const mid = game.midSpot ? 'mid' : rnd() < 0.5 ? one : two;
  let layout = n >= 5 ? [one, one, two, two, mid] : n === 4 ? [one, one, two, two] : n === 3 ? [one, two, mid] : n === 2 ? [one, two] : [rnd() < 0.5 ? one : two];
  const hit = game.tSiteHistory || [];
  const stack = hit.length >= 2 && hit[hit.length - 1] === hit[hit.length - 2] && n >= 4 && rnd() < skill ? hit[hit.length - 1] : null;
  if (stack) layout = layout.map((s, i) => (i < Math.ceil(n * 0.6) ? stack : s === stack ? (stack === one ? two : one) : s));
  order.forEach((c, i) => assign.set(c, layout[i % layout.length]));
  // Each one's position on its site (setups.js): the usual ones the more often, an AWPer's for an AWPer, never two on
  // one (more than there are: spots.js's own spots for the rest).
  const setup = setupOf(game)?.CT, pos = new Map();
  if (setup) {
    for (const s of new Set(layout)) {
      const left = (setup[s] || []).slice();
      for (const b of bots.filter((x) => assign.get(x.c) === s).sort((x, y) => isAwp(y) - isAwp(x))) {
        const pool = isAwp(b) && left.some((p) => p.awp) ? left.filter((p) => p.awp) : left;
        if (!pool.length) break;
        const p = pickUsual(pool);
        left.splice(left.indexOf(p), 1);
        pos.set(b.c, p);
      }
    }
  }
  // Its utility at the chokes of each site (a smoke early, a molotov as they come: see ai.js).
  const throws = [];
  for (const s of new Set(layout)) {
    if (s === 'mid') continue;
    const mates = bots.filter((b) => assign.get(b.c) === s);
    throws.push(...assignThrows(game, mates, 'CT', ['hold' + s], null).slice(0, 2)); // (a smoke, and a molotov for when they come)
  }
  // (The setup, called as players do: "A jungle and ticket booth, mid window, B bench".)
  const where = [...new Set(layout)].map((s) => [s, bots.filter((b) => assign.get(b.c) === s && pos.has(b.c)).map((b) => pos.get(b.c).name)]).filter(([, n]) => n.length);
  const setupCall = where.length ? where.map(([s, n]) => (s === 'mid' ? 'mid ' : s + ' ') + n.join(' and ')).join(', ') : null;
  const call = stack ? `Stack ${stack}, they keep coming there` : econ === 'eco' ? 'Saving this round, play safe' : econ === 'force' ? 'Force buy, play for picks' : setupCall;
  // Now and then one of them plays aggressive early: out along its way in for information or a pick, then back to its
  // spot (see Brain.probing). Never the AWPer.
  const pushers = bots.filter((b) => !isAwp(b));
  const aggro = pushers.length && rnd() < AGGRO ? pick(pushers).c : null;
  return { side, assign, pos, igl, throws, econ, call, stack, stage: 'hold', rotate: null, sightings: new Map(), aggro };
}

// A terrorist plan moves on: from the default's setup to gathering by the site late in the round (or after a pick), and
// from gathering to the execute once most of them are there and the throwers are on their spots, or half of them have
// been there a few seconds with the throwers on their spots (the rest on their way: they don't stand waiting for the
// last one; the smokes go out, though), or time's short.
export const GATHER_WAIT = 6;
export function advancePlan(game, plan, t) {
  if (plan?.side !== 'T' || plan.stage === 'execute') return;
  const left = game.match.time;
  if (plan.stage === 'setup' && (left <= plan.execAt + 12 || plan.pick)) plan.stage = 'gather';
  if (plan.stage !== 'gather') return;
  const stage = plan.staging || stagingPoint(game, plan.site);
  const bots = game.bots.filter((b) => b.c.team === 'T' && b.c.alive);
  const off = (x) => { const b = game.botOf(x.by); return b ? Math.hypot(b.pos[0] - x.lineup.pos[0], b.pos[1] - x.lineup.pos[1]) : Infinity; };
  // (On it, or standing as near as it gets: see Brain.doLineup.)
  const onSpot = (x) => { const d = off(x), v = game.botOf(x.by)?.vel; return d < 6 || (d < 40 && (!v || Math.hypot(v[0], v[1]) < 30)); };
  // (Each thrower's next lineup, the one it's on its way to or waiting on: one with a smoke and a molotov from two spots
  // can only be on one of them, and waiting for both to be held the execute back to the clock every time.)
  const next = new Map();
  for (const x of plan.throws) if (!x.done && x.by.alive && !next.has(x.by)) next.set(x.by, x);
  const pending = [...next.values()];
  const there = bots.filter((b) => Math.hypot(b.pos[0] - stage[0], b.pos[1] - stage[1]) < 700 || pending.some((x) => x.by === b.c && onSpot(x)));
  if (there.length >= Math.ceil(bots.length / 2) && pending.every(onSpot)) plan.halfThere ??= t; else plan.halfThere = null;
  if (left <= plan.execAt || left < 45 || (there.length >= Math.ceil(bots.length * 0.75) && pending.every(onSpot)) || (plan.halfThere != null && t - plan.halfThere >= GATHER_WAIT)) {
    plan.stage = 'execute';
    plan.execStart = t;
    if (plan.igl?.alive) game.radio?.say(plan.igl, 'letsgo', `Go ${plan.site}, go go go!`);
  }
}
