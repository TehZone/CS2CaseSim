// Database: Postgres (Neon) in production via DATABASE_URL, or an embedded Postgres (PGlite) for local runs and
// tests. Both expose query(sql, params) and tx(fn) where fn gets its own query function inside a transaction.

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL UNIQUE, pass TEXT NOT NULL,
     state JSONB NOT NULL, created BIGINT NOT NULL, last_seen BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS trades (
     id TEXT PRIMARY KEY, from_id INT NOT NULL, to_id INT NOT NULL, status TEXT NOT NULL, version INT NOT NULL,
     offer JSONB NOT NULL, created BIGINT NOT NULL, updated BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS trades_to ON trades (to_id, status)`,
  `CREATE INDEX IF NOT EXISTS trades_from ON trades (from_id, status)`,
  `CREATE TABLE IF NOT EXISTS rounds (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, data JSONB NOT NULL, created BIGINT NOT NULL, updated BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS rounds_status ON rounds (status)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)`,
  // The admin panel and Discord linking (server/admin.mjs). IP addresses are only ever kept as salted hashes.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_name TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_at BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS config JSONB`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS config_at BIGINT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_discord ON users (discord_id) WHERE discord_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS user_ips (
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ip_hash TEXT NOT NULL, last BIGINT NOT NULL, PRIMARY KEY (user_id, ip_hash))`,
  `CREATE INDEX IF NOT EXISTS user_ips_hash ON user_ips (ip_hash)`,
  `CREATE TABLE IF NOT EXISTS bans (
     id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, ip_hash TEXT, reason TEXT NOT NULL, by_name TEXT NOT NULL,
     created BIGINT NOT NULL, expires BIGINT, lifted BIGINT, lifted_by TEXT)`,
  // The banner's staff level: a ban can only be lifted at that level or above (older rows: NULL, anyone).
  `ALTER TABLE bans ADD COLUMN IF NOT EXISTS by_level INT`,
  `CREATE INDEX IF NOT EXISTS bans_user ON bans (user_id)`,
  `CREATE INDEX IF NOT EXISTS bans_ip ON bans (ip_hash)`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL, kind TEXT NOT NULL,
     state JSONB NOT NULL, config JSONB, by_name TEXT NOT NULL, created BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS snapshots_user ON snapshots (user_id, created)`,
  `CREATE TABLE IF NOT EXISTS notes (
     id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, by_name TEXT NOT NULL, text TEXT NOT NULL, created BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id SERIAL PRIMARY KEY, at BIGINT NOT NULL, actor TEXT NOT NULL, actor_discord TEXT, action TEXT NOT NULL, target_id INT, target_name TEXT,
     detail JSONB NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit (at)`,
  `CREATE INDEX IF NOT EXISTS audit_target ON audit (target_id, at)`,
];

export async function openDb({ url = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DIR } = {}) {
  let db;
  if (url) {
    const { default: pg } = await import('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: url, ssl, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000 });
    pool.on('error', (e) => console.warn('[db] idle client error', e.message));
    db = {
      kind: 'postgres',
      query: (sql, params) => pool.query(sql, params),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn((sql, params) => c.query(sql, params));
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = dataDir ? new PGlite(dataDir) : new PGlite();
    await lite.waitReady;
    // PGlite runs one statement at a time; queue transactions so they don't interleave.
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
    db = {
      kind: dataDir ? 'pglite:' + dataDir : 'pglite:memory',
      query: (sql, params) => serial(() => lite.query(sql, params)),
      tx: (fn) => serial(() => lite.transaction((t) => fn((sql, params) => t.query(sql, params)))),
      close: () => lite.close(),
    };
  }
  for (const m of MIGRATIONS) await db.query(m);
  return db;
}
