// Gambling: coinflip, jackpot and case battles. Every round is provably fair: the server seed's SHA-256 hash is
// shown before the round, results come from HMAC-SHA256(serverSeed, "clientSeed:nonce:cursor"), and the seed is
// revealed afterwards so anyone can recompute the result. Virtual currency only; no house edge.
import { D, casePrice } from './data.js';
import { rollFromCase } from './items.js';
import { round2, hashStr } from './util.js';

// ---- SHA-256 / HMAC (sync, works the same in browsers and Node) -----------------------------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const enc = new TextEncoder();
function sha256Bytes(msg) {
  const bytes = typeof msg === 'string' ? enc.encode(msg) : msg;
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, len * 8);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 4294967296));
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = (msg) => hex(sha256Bytes(msg));
function hmacBytes(key, msg) {
  let k = typeof key === 'string' ? enc.encode(key) : key;
  if (k.length > 64) k = sha256Bytes(k);
  const ipad = new Uint8Array(64), opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = (k[i] || 0) ^ 0x36; opad[i] = (k[i] || 0) ^ 0x5c; }
  const m = typeof msg === 'string' ? enc.encode(msg) : msg;
  const inner = new Uint8Array(64 + m.length); inner.set(ipad); inner.set(m, 64);
  const ih = sha256Bytes(inner);
  const outer = new Uint8Array(96); outer.set(opad); outer.set(ih, 64);
  return sha256Bytes(outer);
}
export const hmacHex = (key, msg) => hex(hmacBytes(key, msg));

export function newSeed() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return hex(b);
}

// A stream of fair floats in [0,1) for one round/slot: 8 floats per HMAC block, then the cursor advances.
export function fairRng(serverSeed, clientSeed, nonce) {
  let cursor = 0, block = null, idx = 8;
  return () => {
    if (idx >= 8) { block = hmacBytes(serverSeed, `${clientSeed}:${nonce}:${cursor++}`); idx = 0; }
    const o = idx++ * 4;
    return (((block[o] << 24) | (block[o + 1] << 16) | (block[o + 2] << 8) | block[o + 3]) >>> 0) / 4294967296;
  };
}
export const fairFloat = (serverSeed, clientSeed, nonce) => fairRng(serverSeed, clientSeed, nonce)();

export function newFairness(clientSeed) {
  const serverSeed = newSeed();
  return { serverSeed, hash: sha256Hex(serverSeed), clientSeed: String(clientSeed || newSeed().slice(0, 16)).slice(0, 64) };
}

// ---- bots -------------------------------------------------------------------------------------
const BOT_TAGS = ['bot', 'BOT'];
export function botPlayer(key) {
  const pros = D.proList;
  const h = hashStr('bot:' + key);
  const p = pros.length ? pros[h % pros.length] : null;
  const name = `${BOT_TAGS[h % 2]} ${p ? p.n : 'Ronin'}`;
  return { id: 'bot:' + key, name, bot: true, avatar: p?.img || '', color: `hsl(${h % 360} 60% 45%)` };
}

// ---- coinflip ---------------------------------------------------------------------------------
export const SIDES = ['ct', 't'];
// Heads (< 0.5) is CT.
export const coinflipResult = (serverSeed, clientSeed, nonce = 'flip') => (fairFloat(serverSeed, clientSeed, nonce) < 0.5 ? 'ct' : 't');

// ---- jackpot ----------------------------------------------------------------------------------
// entries: [{ id, value }]. The winning ticket is a fair float times the pot.
export function jackpotWinner(entries, serverSeed, clientSeed, nonce = 'jackpot') {
  const total = entries.reduce((s, e) => s + e.value, 0);
  const ticket = fairFloat(serverSeed, clientSeed, nonce) * total;
  let acc = 0;
  for (const e of entries) { acc += e.value; if (ticket < acc) return { winner: e.id, ticket, total }; }
  return { winner: entries[entries.length - 1].id, ticket, total };
}
// Value a jackpot bot brings: around the pot so far (or the first stake), between a third and double.
export const botJackpotStake = (pot, r) => round2(Math.max(0.5, pot * (0.33 + r() * 1.67)));

// ---- case battles -----------------------------------------------------------------------------
export const BATTLE_FORMATS = {
  '1v1': { seats: 2, teams: [[0], [1]] },
  '1v1v1': { seats: 3, teams: [[0], [1], [2]] },
  '1v1v1v1': { seats: 4, teams: [[0], [1], [2], [3]] },
  '2v2': { seats: 4, teams: [[0, 1], [2, 3]] },
};
export const BATTLE_MODES = { normal: 'Highest total wins', crazy: 'Crazy: lowest total wins' };
export const MAX_BATTLE_ROUNDS = 20;
export const battleCost = (caseIds) => round2(caseIds.reduce((s, id) => s + casePrice(D.caseById[id]), 0));

// Rolls every seat for every round. `value` prices items (the caller's itemValue).
export function runBattle({ cases, format, mode }, fair, value) {
  const f = BATTLE_FORMATS[format];
  const rounds = cases.map((cid, ri) => {
    const box = D.caseById[cid];
    return Array.from({ length: f.seats }, (_, seat) => rollFromCase(box, fairRng(fair.serverSeed, fair.clientSeed, `${ri}:${seat}`)));
  });
  const seatTotals = Array.from({ length: f.seats }, (_, s) => round2(rounds.reduce((t, r) => t + value(r[s]), 0)));
  const teamTotals = f.teams.map((t) => round2(t.reduce((s, seat) => s + seatTotals[seat], 0)));
  const best = mode === 'crazy' ? Math.min(...teamTotals) : Math.max(...teamTotals);
  let tied = teamTotals.map((t, i) => (t === best ? i : -1)).filter((i) => i >= 0);
  const tiebreak = tied.length > 1 ? fairFloat(fair.serverSeed, fair.clientSeed, 'tiebreak') : 0;
  const winTeam = tied.length > 1 ? tied[Math.floor(tiebreak * tied.length)] : tied[0];
  // The winning team takes everything. Teammates keep their own drops and share the rest round-robin by value.
  const winners = f.teams[winTeam];
  const share = Object.fromEntries(winners.map((s) => [s, rounds.map((r) => r[s])]));
  const rest = [];
  for (const r of rounds) r.forEach((it, seat) => { if (!winners.includes(seat)) rest.push(it); });
  rest.sort((a, b) => value(b) - value(a)).forEach((it, i) => share[winners[i % winners.length]].push(it));
  return { rounds, seatTotals, teamTotals, winTeam, winners, share, tiebreak: tied.length > 1 };
}
