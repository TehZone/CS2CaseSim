// Accounts: username + password (scrypt hashes), 30-day session tokens (only their SHA-256 is stored).
import crypto from 'node:crypto';
import { freshState } from '../src/js/engine/economy.js';

const NAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const BLOCKED = ['admin', 'moderator', 'server', 'system', 'valve', 'bot'];
const RUDE = /(fuck|shit|cunt|nigg|fag|rape|hitler|nazi)/i;

const scrypt = (pass, salt) => new Promise((res, rej) => crypto.scrypt(pass, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class AuthError extends Error {}

export function validName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'Username: 3-20 letters, numbers, _ or -';
  if (BLOCKED.some((b) => name.toLowerCase() === b || name.toLowerCase().startsWith(b + '_')) || RUDE.test(name)) return 'Please pick another username';
  return '';
}

async function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pass, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function checkPassword(pass, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const k = await scrypt(pass, Buffer.from(salt, 'base64'));
  const want = Buffer.from(key, 'base64');
  return want.length === k.length && crypto.timingSafeEqual(want, k);
}

async function newSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('INSERT INTO sessions (token_hash, user_id, expires) VALUES ($1, $2, $3)', [sha(token), userId, Date.now() + SESSION_MS]);
  return token;
}

export async function register(db, name, pass) {
  const bad = validName(name);
  if (bad) throw new AuthError(bad);
  if (typeof pass !== 'string' || pass.length < 6 || pass.length > 200) throw new AuthError('Password: at least 6 characters');
  const st = freshState();
  delete st.settings;
  const now = Date.now();
  st.lastTick = now;
  let id;
  try {
    const { rows } = await db.query(
      'INSERT INTO users (name, name_lc, pass, state, created, last_seen) VALUES ($1, $2, $3, $4::jsonb, $5, $5) RETURNING id',
      [name, name.toLowerCase(), await hashPassword(pass), JSON.stringify(st), now],
    );
    id = rows[0].id;
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) throw new AuthError('That username is taken');
    throw e;
  }
  return { id, name, token: await newSession(db, id) };
}

export async function login(db, name, pass) {
  if (typeof name !== 'string' || typeof pass !== 'string') throw new AuthError('Wrong username or password');
  const { rows } = await db.query('SELECT id, name, pass FROM users WHERE name_lc = $1', [name.toLowerCase()]);
  // Hash anyway when the user doesn't exist, so timing doesn't reveal which usernames exist.
  const ok = rows.length ? await checkPassword(pass, rows[0].pass) : (await hashPassword(pass), false);
  if (!ok) throw new AuthError('Wrong username or password');
  return { id: rows[0].id, name: rows[0].name, token: await newSession(db, rows[0].id) };
}

export async function userForToken(db, token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const { rows } = await db.query(
    'SELECT u.id, u.name, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1', [sha(token)]);
  if (!rows.length || Number(rows[0].expires) < Date.now()) return null;
  return { id: rows[0].id, name: rows[0].name };
}

export async function logout(db, token) {
  if (typeof token === 'string') await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

// Simple fixed-window rate limiter.
export function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.t > windowMs) hits.set(key, (h = { t: now, n: 0 }));
    return ++h.n <= max;
  };
}
