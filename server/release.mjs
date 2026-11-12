// The version lock: only the game's latest published release may play online, so publishing a release locks out older
// versions. The server learns the version from the release itself (latest.json, see shared/release.cjs):
//   - until a release has been seen, nobody is refused: pushing the server to Render before a release is out locks no one out
//   - the version seen last is kept in the database and a failed check changes nothing: a GitHub outage locks no one out,
//     not even across a restart
//   - the newest release going back to an older one (a bad release deleted) lowers the version again
// The game sends its version in its hello. A game that sends none is from before the updater and counts as outdated.
// When a release comes out, the players connected on older versions are told at once and dropped after `grace`.
// Off unless NODE_ENV is production or RELEASE_FEED is set; RELEASE_FEED=off is the switch to let every version back in
// (every version that has the server's data: in production what waits for a release keeps waiting, server/index.mjs gated).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RELEASE_FEED, RELEASE_PAGE, isOutdated, parseManifest, outdatedText } = require('../shared/release.cjs');
const MIN = 60 * 1000;

// startServer's `release` option from the environment: false (off) or the Release options.
export function releaseFromEnv(env = process.env) {
  if (env.RELEASE_FEED === 'off') return false;
  if (env.RELEASE_FEED) return { feed: env.RELEASE_FEED };
  return env.NODE_ENV === 'production' ? {} : false;
}

export class Release {
  // (`fetcher`: tests answer for GitHub.)
  constructor(srv, opts) {
    this.srv = srv;
    this.on = opts !== false;
    // (onVersion(version): told each time the required version changes, after the change is saved.)
    const { feed = RELEASE_FEED, every = 5 * MIN, grace = 5 * MIN, fetcher = (...a) => fetch(...a), onVersion = null } = opts || {};
    Object.assign(this, { feed, every, grace, fetcher, onVersion });
    this.required = null; // the version the game must be at least, null while no release has been seen
    this.failing = false;
    this.timer = this.dropTimer = null;
  }

  async init() {
    if (!this.on) return;
    try {
      const { rows } = await this.srv.db.query("SELECT v FROM kv WHERE k = 'release'");
      const saved = rows[0] && (typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v);
      if (saved?.version) this.required = saved.version;
    } catch (e) { this.srv.log('[release] could not load the required version', e.message); }
    this.srv.log(`[release] required version: ${this.required || 'none yet'}`);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.every);
    this.timer.unref?.();
  }

  // A game on this version, refused: what its hello gets, or null to let it in.
  refusal(app) {
    if (!this.on || !isOutdated(app, this.required)) return null;
    return { t: 'fatal', code: 'outdated', error: outdatedText(this.required), required: this.required, url: RELEASE_PAGE };
  }

  // Reads the latest release. Anything going wrong (no release yet, GitHub down, a broken file) leaves things as they are.
  async poll() {
    let m;
    try {
      const res = await this.fetcher(this.feed, { headers: { 'user-agent': 'cs2-case-sim-server', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      m = parseManifest(await res.json());
      if (!m) throw new Error('no release in the file');
    } catch (e) {
      if (!this.failing) this.srv.log(`[release] no release read (${e.message}): required version stays ${this.required || 'none'}`);
      this.failing = true;
      return false;
    }
    this.failing = false;
    if (m.version === this.required) return true;
    const was = this.required;
    this.required = m.version;
    this.srv.log(`[release] required version: ${was || 'none'} -> ${m.version}`);
    await this.srv.db.query("INSERT INTO kv (k, v) VALUES ('release', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify({ version: m.version, at: Date.now() })])
      .catch((e) => this.srv.log('[release] could not save the required version', e.message));
    this.warnConnected();
    try { this.onVersion?.(m.version); } catch (e) { this.srv.log('[release] onVersion failed', e?.message || e); }
    return true;
  }

  // Every connection of a game this release leaves behind.
  outdated() {
    const out = [];
    for (const set of this.srv.sockets.values()) for (const ws of set) if (this.refusal(ws.app)) out.push(ws);
    return out;
  }

  warnConnected() {
    const left = Math.max(1, Math.round(this.grace / MIN));
    const stale = this.outdated();
    for (const ws of stale) {
      if (ws.readyState !== 1) continue;
      ws.send(JSON.stringify({ t: 'notice', type: 'gold', msg: `Version ${this.required} is out. Update the game: you'll be taken offline in ${left} minute${left === 1 ? '' : 's'}.` }));
      ws.send(JSON.stringify({ t: 'update', version: this.required }));
    }
    clearTimeout(this.dropTimer);
    if (!stale.length) return;
    this.dropTimer = setTimeout(() => this.dropOutdated(), this.grace);
    this.dropTimer.unref?.();
  }

  // (As a kick does it: the connection's own close takes it off the server, and whatever it still sends is ignored.)
  dropOutdated() {
    const stale = this.outdated();
    for (const ws of stale) {
      ws.kicked = true;
      if (ws.readyState === 1) ws.send(JSON.stringify(this.refusal(ws.app)));
      ws.close(1000);
    }
    if (stale.length) this.srv.log(`[release] dropped ${stale.length} connection${stale.length === 1 ? '' : 's'} on older versions`);
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.dropTimer);
  }
}
