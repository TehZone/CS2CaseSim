// Online PvP's wire format inside the /match socket's binary frames (the relay reads only their first bytes: engine/pvp.js
// FRAME, server/relay.mjs). Pure: no DOM, no game; scripts/test-pvp-net.mjs runs it in Node. Little-endian throughout.
//
//   CMDS     client -> host   [0x01][n u8 1-4][cmd]×n                       (one message a frame, a cmd a tick)
//   INPUTS   relay -> host    [0x81][k u8]{[slot u8][len u16][n u8][cmd]×n}
//   BUNDLE   host -> relay    [0x10][tick u32][sharedLen u16][shared][k u8]{[slot u8][len u16][own]}
//   SNAP     relay -> client  [0x90][tick u32][sharedLen u16][shared][own, or nothing]
//   UNICAST  host -> relay    [0x11][slot u8][kind u8][...]  -> that client gets [0x91][kind u8][...]
//              kind 1: a keyframe   [tick u32][sharedLen u16][shared (every field)][ownLen u16][own]
//              kind 2: JSON         [len u16][utf8]   (the roster: who the bots are)
//
// A cmd (about 21 bytes): seq u16, view u32 (the host tick × 256 the client was drawing everyone else at: lag compensation
// rewinds to it), buttons u32 (B below), fwd i8 and side i8 (×127), yaw f32 and pitch f32 (degrees; the client moves by the
// same rounded values the host does), then TLVs [type u8][len u8][data]: a buy (u16 index in CATALOG_IDS), a ping (3×f32).
//
// The shared part is delta-coded against the previous one (TCP keeps them in order; a keyframe starts a client over):
//   [flags u8 (1 key)][matchMask u8][match…][nBodies u8]{[slot u8][mask u8][fields…]}[nBoard u8]{row}[nDoors u8]{door}
//   [nPanes u8]{pane}[nEvents u8]{[type u8][len u8][payload]}
// The own part (each client's own, every snapshot): [ack u16][depth u8][flags u8][movement (f64 where it must be exact)]
//   [weapons block if flags has it][nEvents u8]{event}.
// (grenades.js's NADE_ORDER, here so this file needs nothing of the game's: test-pvp-net.mjs checks they're the same)
export const NADE_ORDER = ['weapon_hegrenade', 'weapon_flashbang', 'weapon_smokegrenade', 'weapon_molotov', 'weapon_incgrenade', 'weapon_decoy'];

// ---- bytes ---------------------------------------------------------------------------------------------------------------
export class Writer {
  constructor(size = 2048) { this.alloc(size); this.p = 0; }
  alloc(size) {
    const old = this.u ? this.u.subarray(0, this.p) : null;
    this.buf = new ArrayBuffer(size);
    this.dv = new DataView(this.buf);
    this.u = new Uint8Array(this.buf);
    if (old) this.u.set(old);
  }
  reset() { this.p = 0; return this; }
  need(n) { if (this.p + n > this.buf.byteLength) this.alloc(Math.max(this.buf.byteLength * 2, this.p + n + 256)); }
  byte(v) { this.need(1); this.u[this.p++] = v & 255; return this; }
  i8(v) { this.need(1); this.dv.setInt8(this.p, v); this.p += 1; return this; }
  u16(v) { this.need(2); this.dv.setUint16(this.p, v & 0xffff, true); this.p += 2; return this; }
  i16(v) { this.need(2); this.dv.setInt16(this.p, Math.max(-32768, Math.min(32767, Math.round(v))), true); this.p += 2; return this; }
  u32(v) { this.need(4); this.dv.setUint32(this.p, v >>> 0, true); this.p += 4; return this; }
  i32(v) { this.need(4); this.dv.setInt32(this.p, v | 0, true); this.p += 4; return this; }
  f32(v) { this.need(4); this.dv.setFloat32(this.p, v, true); this.p += 4; return this; }
  f64(v) { this.need(8); this.dv.setFloat64(this.p, v, true); this.p += 8; return this; }
  bytes(a) { this.need(a.length); this.u.set(a, this.p); this.p += a.length; return this; }
  str8(s) { const b = utf8(String(s ?? '')).subarray(0, 255); this.byte(b.length); return this.bytes(b); }
  // A length (u8 or u16) written later: → its position.
  mark(size = 1) { const at = this.p; this.need(size); this.p += size; return at; }
  setU8(at, v) { this.u[at] = v & 255; }
  setU16(at, v) { this.dv.setUint16(at, v & 0xffff, true); }
  done() { return this.u.slice(0, this.p); }
}
const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null, dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const utf8 = (s) => enc.encode(s);

export class Reader {
  constructor(data, at = 0, end = null) {
    const u = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.u = u;
    this.dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    this.p = at;
    this.end = end ?? u.byteLength;
  }
  get left() { return this.end - this.p; }
  check(n) { if (this.p + n > this.end) throw new RangeError('short frame'); }
  byte() { this.check(1); return this.u[this.p++]; }
  i8() { this.check(1); return this.dv.getInt8(this.p++); }
  u16() { this.check(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i16() { this.check(2); const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  u32() { this.check(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { this.check(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { this.check(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { this.check(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  bytes(n) { this.check(n); const v = this.u.subarray(this.p, this.p + n); this.p += n; return v; }
  str8() { const n = this.byte(); return dec.decode(this.bytes(n)); }
  sub(n) { this.check(n); const r = new Reader(this.u, this.p, this.p + n); this.p += n; return r; }
}

// ---- numbers both sides must agree on ------------------------------------------------------------------------------------
// A u32 hash of a few u32s (a seed for a shot's spread: the match's seed, the shooter's slot, the cmd's seq).
export function hash32(...xs) {
  let h = 0x811c9dc5;
  for (const x of xs) {
    let k = Math.imul(x >>> 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
// Angles as the client sends them: yaw in -180..180, both rounded to f32 (the host moves by exactly these).
export const wrapYaw = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
export const netYaw = (a) => Math.fround(wrapYaw(a));
export const netPitch = (a) => Math.fround(Math.max(-89, Math.min(89, a)));
// The 16-bit seq on the wire, unwrapped against the last 32-bit one seen (either way, ±32767).
export const unwrapSeq = (s16, last) => last + ((((s16 - (last & 0xffff)) & 0xffff) ^ 0x8000) - 0x8000);

// ---- weapons by number ---------------------------------------------------------------------------------------------------
// The weapons every match knows by number (catalog guns, grenades, the default knives, the bomb); any other (a knife skin's
// own model) goes as its id after 0xffff.
export const WEAPON_IDS = ['', 'weapon_glock', 'weapon_usp_silencer', 'weapon_hkp2000', 'weapon_elite', 'weapon_p250', 'weapon_tec9', 'weapon_fiveseven',
  'weapon_cz75a', 'weapon_deagle', 'weapon_revolver', 'weapon_mac10', 'weapon_mp9', 'weapon_mp7', 'weapon_mp5sd', 'weapon_ump45', 'weapon_p90',
  'weapon_bizon', 'weapon_nova', 'weapon_xm1014', 'weapon_sawedoff', 'weapon_mag7', 'weapon_negev', 'weapon_m249', 'weapon_galilar', 'weapon_famas',
  'weapon_ak47', 'weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_ssg08', 'weapon_sg556', 'weapon_aug', 'weapon_awp', 'weapon_g3sg1', 'weapon_scar20',
  'weapon_taser', 'weapon_knife', 'weapon_knife_t', 'weapon_c4', ...NADE_ORDER];
const WEAPON_NO = new Map(WEAPON_IDS.map((id, i) => [id, i]));
export function writeWid(w, id) {
  const n = WEAPON_NO.get(id || '');
  if (n != null) w.u16(n); else { w.u16(0xffff); w.str8(id); }
}
export function readWid(r) { const n = r.u16(); return n === 0xffff ? r.str8() : WEAPON_IDS[n] || ''; }
// What can be bought, by number (a cmd's buy).
export const BUY_IDS = [...WEAPON_IDS.slice(1, 36), ...NADE_ORDER, 'vest', 'vesthelm', 'defuser'];
const BUY_NO = new Map(BUY_IDS.map((id, i) => [id, i]));
export const buyIndex = (id) => BUY_NO.get(id) ?? -1;

// ---- cmds ----------------------------------------------------------------------------------------------------------------
// buttons: held (ATTACK..USE), pressed this tick (RELOAD..USEPRESS, the CLICKs: a press that may have let go already), a
// slot key (bits 16-18: 1..5 is slot1..slot5), FROZEN: the buy menu, the chat or the console has the keys (no firing).
export const B = {
  ATTACK: 1, ATTACK2: 2, JUMP: 4, DUCK: 8, WALK: 16, USE: 32, RELOAD: 64, INSPECT: 128, DROP: 256, JUMPPRESS: 512, LASTINV: 1024,
  INVNEXT: 2048, INVPREV: 4096, PING: 8192, FROZEN: 16384, USEPRESS: 32768, CLICK1: 1 << 19, CLICK2: 1 << 20,
};
export const SLOT_SHIFT = 16;
export const ONE_SHOT = B.RELOAD | B.INSPECT | B.DROP | B.JUMPPRESS | B.LASTINV | B.INVNEXT | B.INVPREV | B.PING | B.USEPRESS | B.CLICK1 | B.CLICK2 | (7 << SLOT_SHIFT);
const TLV = { BUY: 1, PING: 3 };

// cmd: { seq, view, buttons, fwd, side, yaw, pitch, buys?: [buy index], ping?: [x, y, z] }
export function writeCmd(w, c) {
  w.u16(c.seq); w.u32(c.view); w.u32(c.buttons);
  w.i8(Math.round(Math.max(-1, Math.min(1, c.fwd)) * 127)); w.i8(Math.round(Math.max(-1, Math.min(1, c.side)) * 127));
  w.f32(c.yaw); w.f32(c.pitch);
  const n = (c.buys?.length || 0) + (c.ping ? 1 : 0);
  w.byte(n);
  for (const b of c.buys || []) { w.byte(TLV.BUY); w.byte(2); w.u16(b); }
  if (c.ping) { w.byte(TLV.PING); w.byte(12); w.f32(c.ping[0]); w.f32(c.ping[1]); w.f32(c.ping[2]); }
}
export function readCmd(r) {
  const c = { seq: r.u16(), view: r.u32(), buttons: r.u32(), fwd: r.i8() / 127, side: r.i8() / 127, yaw: r.f32(), pitch: r.f32(), buys: null, ping: null };
  for (let n = r.byte(); n > 0; n--) {
    const type = r.byte(), len = r.byte(), body = r.sub(len);
    if (type === TLV.BUY && len >= 2) (c.buys ||= []).push(body.u16());
    else if (type === TLV.PING && len >= 12) c.ping = [body.f32(), body.f32(), body.f32()];
  }
  return c;
}
// One CMDS frame: [0x01][n][cmd]×n (at most 4: a frame of more is split).
export function cmdsFrame(cmds, w = new Writer(256)) {
  w.reset().byte(0x01).byte(cmds.length);
  for (const c of cmds) writeCmd(w, c);
  return w.done();
}
// An INPUTS frame from the relay: → [{ slot, cmds }] (a body that doesn't read is skipped).
export function readInputs(data) {
  const r = new Reader(data), out = [];
  if (r.byte() !== 0x81) return out;
  for (let k = r.byte(); k > 0; k--) {
    const slot = r.byte(), len = r.u16(), body = r.sub(len);
    try {
      const cmds = [];
      for (let n = body.byte(); n > 0; n--) cmds.push(readCmd(body));
      out.push({ slot, cmds });
    } catch { /* a bad body: dropped */ }
  }
  return out;
}

// ---- bodies (the shared part) --------------------------------------------------------------------------------------------
// A body as everyone sees it. flags: alive, ducked, ground, ladder, planting, defusing, scoped, walking; flags2: helmet, kit,
// c4, blind, bot (a bot plays for this player), away. team 0 CT, 1 T. skin: whose look its gun has (a slot), 255 the default.
export const F = { ALIVE: 1, DUCKED: 2, GROUND: 4, LADDER: 8, PLANTING: 16, DEFUSING: 32, SCOPED: 64, WALKING: 128 };
export const F2 = { HELMET: 1, KIT: 2, C4: 4, BLIND: 8, BOT: 16, AWAY: 32 };
const M = { POS: 1, VEL: 2, ANG: 4, FLAGS: 8, HELD: 16, HP: 32, CLIP: 64, TEAM: 128 };
export const newBody = (slot) => ({ slot, pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, flags: 0, flags2: 0, held: '', skin: 255, hp: 0, armor: 0, clip: 0, reserve: 0, team: 0 });
const q = (v, s) => Math.round(v * s);
// What changed between two bodies as sent (the quantized values: a change the wire can't show isn't one).
function bodyMask(a, b) {
  if (!b) return 255;
  let m = 0;
  if (Math.fround(a.pos[0]) !== Math.fround(b.pos[0]) || Math.fround(a.pos[1]) !== Math.fround(b.pos[1]) || Math.fround(a.pos[2]) !== Math.fround(b.pos[2])) m |= M.POS;
  if (q(a.vel[0], 4) !== q(b.vel[0], 4) || q(a.vel[1], 4) !== q(b.vel[1], 4) || q(a.vel[2], 4) !== q(b.vel[2], 4)) m |= M.VEL;
  if (yawU16(a.yaw) !== yawU16(b.yaw) || pitchI16(a.pitch) !== pitchI16(b.pitch)) m |= M.ANG;
  if (a.flags !== b.flags || a.flags2 !== b.flags2) m |= M.FLAGS;
  if (a.held !== b.held || a.skin !== b.skin) m |= M.HELD;
  if ((a.hp | 0) !== (b.hp | 0) || (a.armor | 0) !== (b.armor | 0)) m |= M.HP;
  if ((a.clip | 0) !== (b.clip | 0) || (a.reserve | 0) !== (b.reserve | 0)) m |= M.CLIP;
  if (a.team !== b.team) m |= M.TEAM;
  return m;
}
const yawU16 = (y) => q(((wrapYaw(y) + 360) % 360) / 360, 65536) & 0xffff;
const pitchI16 = (p) => q(Math.max(-90, Math.min(90, p)) / 90, 32767);
function writeBody(w, b, m) {
  w.byte(b.slot); w.byte(m);
  if (m & M.POS) { w.f32(b.pos[0]); w.f32(b.pos[1]); w.f32(b.pos[2]); }
  if (m & M.VEL) { w.i16(b.vel[0] * 4); w.i16(b.vel[1] * 4); w.i16(b.vel[2] * 4); }
  if (m & M.ANG) { w.u16(yawU16(b.yaw)); w.i16(pitchI16(b.pitch)); }
  if (m & M.FLAGS) { w.byte(b.flags); w.byte(b.flags2); }
  if (m & M.HELD) { writeWid(w, b.held); w.byte(b.skin); }
  if (m & M.HP) { w.byte(Math.max(0, Math.min(255, Math.ceil(b.hp)))); w.byte(Math.max(0, Math.min(255, Math.ceil(b.armor)))); }
  if (m & M.CLIP) { w.byte(Math.max(0, Math.min(255, b.clip | 0))); w.u16(Math.max(0, Math.min(65535, b.reserve | 0))); } // (the magazine and the reserve: a spectator's HUD shows both)
  if (m & M.TEAM) w.byte(b.team);
}
// Into `into` (the body as it was): the fields the record has.
function readBody(r, bodies) {
  const slot = r.byte(), m = r.byte();
  const b = (bodies[slot] ||= newBody(slot));
  if (m & M.POS) { b.pos[0] = r.f32(); b.pos[1] = r.f32(); b.pos[2] = r.f32(); }
  if (m & M.VEL) { b.vel[0] = r.i16() / 4; b.vel[1] = r.i16() / 4; b.vel[2] = r.i16() / 4; }
  if (m & M.ANG) { const y = r.u16() / 65536 * 360; b.yaw = y >= 180 ? y - 360 : y; b.pitch = r.i16() / 32767 * 90; }
  if (m & M.FLAGS) { b.flags = r.byte(); b.flags2 = r.byte(); }
  if (m & M.HELD) { b.held = readWid(r); b.skin = r.byte(); }
  if (m & M.HP) { b.hp = r.byte(); b.armor = r.byte(); }
  if (m & M.CLIP) { b.clip = r.byte(); b.reserve = r.u16(); }
  if (m & M.TEAM) b.team = r.byte();
  return b;
}
const copyBody = (b) => ({ ...b, pos: b.pos.slice(), vel: b.vel.slice() });

// ---- the match -------------------------------------------------------------------------------------------------------------
export const PHASES = ['freeze', 'live', 'planted', 'end', 'over'];
export const BOMB_STATES = ['carried', 'dropped', 'planted', 'defused', 'exploded'];
const MB = { STATE: 1, TIME: 2, BOMB: 4, TIMEOUT: 8 };
export const newMatch = () => ({ phase: 'freeze', round: 0, score: { A: 0, B: 0 }, swapped: false, time: 0, timeAt: 0,
  bomb: { state: 'carried', carrier: 255, pos: [0, 0, 0], site: '', plantedLeft: 0, defuser: 255, defuseLeft: 0 }, timeout: 0 });
function matchMask(a, b, timeDue) {
  if (!b) return 15;
  let m = 0;
  if (a.phase !== b.phase || a.round !== b.round || a.score.A !== b.score.A || a.score.B !== b.score.B || a.swapped !== b.swapped) m |= MB.STATE | MB.TIME;
  if (timeDue) m |= MB.TIME;
  const x = a.bomb, y = b.bomb;
  if (x.state !== y.state || x.carrier !== y.carrier || x.defuser !== y.defuser || x.site !== y.site || Math.fround(x.pos[0]) !== Math.fround(y.pos[0])
    || Math.fround(x.pos[1]) !== Math.fround(y.pos[1]) || Math.fround(x.pos[2]) !== Math.fround(y.pos[2])) m |= MB.BOMB;
  if (Math.round(a.timeout * 10) !== Math.round(b.timeout * 10) && (timeDue || !a.timeout !== !b.timeout)) m |= MB.TIMEOUT;
  return m;
}
function writeMatch(w, s, m) {
  w.byte(m);
  if (m & MB.STATE) { w.byte(PHASES.indexOf(s.phase)); w.byte(s.round); w.byte(s.score.A); w.byte(s.score.B); w.byte(s.swapped ? 1 : 0); }
  if (m & MB.TIME) w.f32(s.time);
  if (m & MB.BOMB) {
    const b = s.bomb;
    w.byte(Math.max(0, BOMB_STATES.indexOf(b.state))); w.byte(b.carrier); w.f32(b.pos[0]); w.f32(b.pos[1]); w.f32(b.pos[2]);
    w.byte(b.site ? b.site.charCodeAt(0) : 0); w.f32(b.plantedLeft); w.byte(b.defuser); w.f32(b.defuseLeft);
  }
  if (m & MB.TIMEOUT) w.f32(s.timeout);
}
function readMatch(r, s) {
  const m = r.byte();
  if (m & MB.STATE) { s.phase = PHASES[r.byte()] || 'freeze'; s.round = r.byte(); s.score.A = r.byte(); s.score.B = r.byte(); s.swapped = !!r.byte(); }
  if (m & MB.TIME) { s.time = r.f32(); s.timeAt = 0; }
  if (m & MB.BOMB) {
    const b = s.bomb;
    b.state = BOMB_STATES[r.byte()] || 'carried'; b.carrier = r.byte(); b.pos = [r.f32(), r.f32(), r.f32()];
    const site = r.byte(); b.site = site ? String.fromCharCode(site) : ''; b.plantedLeft = r.f32(); b.defuser = r.byte(); b.defuseLeft = r.f32();
  }
  if (m & MB.TIMEOUT) s.timeout = r.f32();
  return m;
}

// ---- the scoreboard, doors, glass ------------------------------------------------------------------------------------------
const rowKey = (x) => `${x.k}|${x.a}|${x.d}|${x.m}|${x.score}|${x.dmg | 0}|${x.money}`;
function writeRow(w, x) { w.byte(x.slot); w.i16(x.k); w.byte(x.a); w.byte(x.d); w.byte(x.m); w.i16(x.score); w.u16(x.dmg); w.u16(x.money); }
function readRow(r) { return { slot: r.byte(), k: r.i16(), a: r.byte(), d: r.byte(), m: r.byte(), score: r.i16(), dmg: r.u16(), money: r.u16() }; }

// ---- events --------------------------------------------------------------------------------------------------------------
// [type u8][len u8][payload]. In the shared part (everyone) or a client's own part (OWN_EVENTS: theirs alone).
export const EV = { SHOT: 1, HURT: 3, KILL: 4, NADE: 5, FLASHED: 7, BOMB: 8, ROUND: 9, BUY: 10, DROP: 11, GEST: 12, RADIO: 13, PING: 14, TELEPORT: 15, MVP: 16 };
export const SHOT_F = { TRACER: 1, SOUND: 2, SILENCED: 4 };
export const ROUND_KIND = { START: 0, LIVE: 1, END: 2, OVER: 3 };
export const BOMB_KIND = { PLANTED: 0, DEFUSED: 1, EXPLODED: 2, DROPPED: 3, PICKED: 4, DEFUSING: 5 };
export const GEST_KIND = ['reload', 'throw', 'lob', 'pullpin', 'flashed', 'flinchHead', 'flinchChest', 'flinchStomach', 'plant', 'defuse', 'move'];
const REASONS = ['elimination', 'bomb', 'defuse', 'time'];
const SIDES = ['CT', 'T'];
const n16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
const writers = {
  [EV.SHOT]: (w, e) => { w.byte(e.slot); writeWid(w, e.wid); w.f32(e.origin[0]); w.f32(e.origin[1]); w.f32(e.origin[2]); w.i16(n16(e.dir[0])); w.i16(n16(e.dir[1])); w.i16(n16(e.dir[2])); w.byte(e.flags); },
  [EV.HURT]: (w, e) => { w.byte(e.attacker); w.byte(e.victim); w.byte(Math.min(255, e.dmg)); w.byte(['head', 'chest', 'stomach', 'arm', 'leg'].indexOf(e.group) & 255); w.byte(e.point ? 1 : 0);
    if (e.point) { w.f32(e.point[0]); w.f32(e.point[1]); w.f32(e.point[2]); w.i8(Math.round((e.dir?.[0] || 0) * 127)); w.i8(Math.round((e.dir?.[1] || 0) * 127)); w.i8(Math.round((e.dir?.[2] || 1) * 127)); } },
  [EV.KILL]: (w, e) => { w.byte(e.attacker); w.byte(e.victim); w.byte(e.assister); writeWid(w, e.wid); w.byte(e.flags); w.byte(e.how); },
  [EV.NADE]: (w, e) => { w.byte(e.slot); writeWid(w, e.wid); for (const v of [...e.origin, ...e.vel]) w.f32(v); },
  [EV.FLASHED]: (w, e) => { w.f32(e.secs); },
  [EV.BOMB]: (w, e) => { w.byte(e.kind); w.byte(e.slot); w.f32(e.pos?.[0] || 0); w.f32(e.pos?.[1] || 0); w.f32(e.pos?.[2] || 0); w.f32(e.yaw || 0); },
  [EV.ROUND]: (w, e) => { w.byte(e.kind); w.byte(e.round); w.byte(e.winner == null ? 255 : SIDES.indexOf(e.winner)); w.byte(e.reason == null ? 255 : REASONS.indexOf(e.reason)); w.byte(e.mvp ?? 255); w.byte(e.mvpKills || 0); w.byte(e.flags || 0); w.byte(e.overtime || 0); },
  [EV.BUY]: (w, e) => { w.byte(e.item); w.byte(e.ok ? 1 : 0); },
  [EV.DROP]: (w, e) => { w.byte(e.op); w.u16(e.id); if (e.op === 0) { writeWid(w, e.wid); w.byte(e.skin); for (const v of [...e.pos, ...e.vel]) w.f32(v); } },
  [EV.GEST]: (w, e) => { w.byte(e.slot); w.byte(Math.max(0, GEST_KIND.indexOf(e.kind))); w.f32(e.secs || 0); },
  [EV.RADIO]: (w, e) => { w.byte(e.slot); w.str8(e.line || ''); w.str8(e.text || ''); },
  [EV.PING]: (w, e) => { w.byte(e.slot); w.f32(e.pos[0]); w.f32(e.pos[1]); w.f32(e.pos[2]); },
  [EV.TELEPORT]: (w, e) => { w.f32(e.yaw); w.f32(e.pitch); },
};
const readers = {
  [EV.SHOT]: (r) => ({ slot: r.byte(), wid: readWid(r), origin: [r.f32(), r.f32(), r.f32()], dir: unit([r.i16() / 32767, r.i16() / 32767, r.i16() / 32767]), flags: r.byte() }),
  [EV.HURT]: (r) => {
    const e = { attacker: r.byte(), victim: r.byte(), dmg: r.byte(), group: ['head', 'chest', 'stomach', 'arm', 'leg'][r.byte()] || 'chest', point: null, dir: null };
    if (r.byte()) { e.point = [r.f32(), r.f32(), r.f32()]; e.dir = [r.i8() / 127, r.i8() / 127, r.i8() / 127]; }
    return e;
  },
  [EV.KILL]: (r) => ({ attacker: r.byte(), victim: r.byte(), assister: r.byte(), wid: readWid(r), flags: r.byte(), how: r.byte() }),
  [EV.NADE]: (r) => ({ slot: r.byte(), wid: readWid(r), origin: [r.f32(), r.f32(), r.f32()], vel: [r.f32(), r.f32(), r.f32()] }),
  [EV.FLASHED]: (r) => ({ secs: r.f32() }),
  [EV.BOMB]: (r) => ({ kind: r.byte(), slot: r.byte(), pos: [r.f32(), r.f32(), r.f32()], yaw: r.f32() }),
  [EV.ROUND]: (r) => {
    const e = { kind: r.byte(), round: r.byte(), winner: SIDES[r.byte()] ?? null, reason: REASONS[r.byte()] ?? null, mvp: r.byte(), mvpKills: r.byte(), flags: r.byte(), overtime: r.byte() };
    return e;
  },
  [EV.BUY]: (r) => ({ item: r.byte(), ok: !!r.byte() }),
  [EV.DROP]: (r) => {
    const e = { op: r.byte(), id: r.u16() };
    if (e.op === 0) { e.wid = readWid(r); e.skin = r.byte(); e.pos = [r.f32(), r.f32(), r.f32()]; e.vel = [r.f32(), r.f32(), r.f32()]; }
    return e;
  },
  [EV.GEST]: (r) => ({ slot: r.byte(), kind: GEST_KIND[r.byte()] || 'reload', secs: r.f32() }),
  [EV.RADIO]: (r) => ({ slot: r.byte(), line: r.str8(), text: r.str8() }),
  [EV.PING]: (r) => ({ slot: r.byte(), pos: [r.f32(), r.f32(), r.f32()] }),
  [EV.TELEPORT]: (r) => ({ yaw: r.f32(), pitch: r.f32() }),
};
function unit(d) { const l = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / l, d[1] / l, d[2] / l]; }
export function writeEvents(w, list) {
  const at = w.mark(1);
  let n = 0;
  for (const e of list) {
    if (n >= 255) break;
    const fn = writers[e.type];
    if (!fn) continue;
    w.byte(e.type);
    const len = w.mark(1), start = w.p;
    fn(w, e);
    if (w.p - start > 255) { w.p = len - 1; continue; } // (too long for its length byte: left out)
    w.setU8(len, w.p - start);
    n++;
  }
  w.setU8(at, n);
}
export function readEvents(r) {
  const out = [];
  for (let n = r.byte(); n > 0; n--) {
    const type = r.byte(), len = r.byte(), body = r.sub(len), fn = readers[type];
    if (!fn) continue;
    try { out.push({ type, ...fn(body) }); } catch { /* a bad event: skipped */ }
  }
  return out;
}

// ---- the shared part: one encoder per match, one decoder per client --------------------------------------------------------
// The host's side: what it last sent (the stream's baseline), each part delta-coded against it; key() is everything.
// state: { match, bodies: [body], board: [row], doors: [{ idx, angle, target }], panes: [{ idx, broken }] }
export class SharedEncoder {
  constructor() { this.last = null; this.rows = new Map(); this.doorsSent = new Map(); this.panesSent = new Map(); this.timeSent = -1; this.w = new Writer(4096); }
  // The next frame of the stream (events: this snapshot's), or (key) a frame with every field, the stream's baseline left as
  // it is.
  encode(state, events, { key = false, now = 0, w = this.w } = {}) {
    w.reset();
    const last = key ? null : this.last;
    w.byte(key ? 1 : 0);
    const timeDue = key || now - this.timeSent >= 0.5;
    const mm = matchMask(state.match, last?.match, timeDue);
    writeMatch(w, state.match, mm);
    if (!key && mm & MB.TIME) this.timeSent = now;
    const nAt = w.mark(1);
    let n = 0;
    for (const b of state.bodies) {
      const m = bodyMask(b, last?.bodies[b.slot]);
      if (!m) continue;
      writeBody(w, b, m); n++;
    }
    w.setU8(nAt, n);
    const rows = state.board.filter((x) => key || this.rows.get(x.slot) !== rowKey(x));
    w.byte(rows.length);
    for (const x of rows) { writeRow(w, x); if (!key) this.rows.set(x.slot, rowKey(x)); }
    const doors = (state.doors || []).filter((d) => key || this.doorsSent.get(d.idx) !== `${d.angle}|${d.target}`).slice(0, 255);
    w.byte(doors.length);
    for (const d of doors) { w.u16(d.idx); w.f32(d.angle); w.f32(d.target); if (!key) this.doorsSent.set(d.idx, `${d.angle}|${d.target}`); }
    const panes = (state.panes || []).filter((p) => key || this.panesSent.get(p.idx) !== p.broken).slice(0, 255);
    w.byte(panes.length);
    for (const p of panes) { w.u16(p.idx); w.byte(p.broken ? 1 : 0); if (!key) this.panesSent.set(p.idx, p.broken); }
    writeEvents(w, key ? [] : events);
    if (!key) this.last = { match: { ...state.match, score: { ...state.match.score }, bomb: { ...state.match.bomb, pos: state.match.bomb.pos.slice() } }, bodies: state.bodies.reduce((a, b) => { a[b.slot] = copyBody(b); return a; }, []) };
    return w.done();
  }
}
// A client's side: the stream's state as it builds up (nothing until a keyframe). → { tick, key, match, bodies (changed
// slots), board (rows), doors, panes, events } or null (a delta before any keyframe: skipped).
export class SharedDecoder {
  constructor() { this.ready = false; this.match = newMatch(); this.bodies = []; this.board = new Map(); }
  decode(data) {
    const r = data instanceof Reader ? data : new Reader(data);
    const flags = r.byte(), key = !!(flags & 1);
    if (!key && !this.ready) return null;
    if (key) this.ready = true;
    const mm = readMatch(r, this.match);
    const changed = [];
    for (let n = r.byte(); n > 0; n--) changed.push(readBody(r, this.bodies).slot);
    const rows = [];
    for (let n = r.byte(); n > 0; n--) { const x = readRow(r); this.board.set(x.slot, x); rows.push(x); }
    const doors = [];
    for (let n = r.byte(); n > 0; n--) doors.push({ idx: r.u16(), angle: r.f32(), target: r.f32() });
    const panes = [];
    for (let n = r.byte(); n > 0; n--) panes.push({ idx: r.u16(), broken: !!r.byte() });
    const events = readEvents(r);
    return { key, matchMask: mm, match: this.match, bodies: this.bodies, changed, rows, doors, panes, events };
  }
}

// ---- the own part ----------------------------------------------------------------------------------------------------------
// flags: TELEPORT (a respawn: start the prediction over, take the aim), WEAPONS (the weapons block follows), PLANTING,
// DEFUSING, ALIVE, BUYZONE.
export const OWN = { TELEPORT: 1, WEAPONS: 2, PLANTING: 4, DEFUSING: 8, ALIVE: 16, BUYZONE: 32 };
const MV = { GROUND: 1, DUCKED: 2, DUCKHELD: 4, JUMPHELD: 8, LADDER: 16, JUMPED: 32, GN: 64, LN: 128 };
// A player's movement (movement.js PlayerMovement) as the wire has it: origin and velocity exactly, the rest as f32.
export function moveState(p, out = {}) {
  out.origin = p.origin.slice(); out.velocity = p.velocity.slice();
  out.onGround = !!p.onGround; out.ducked = !!p.ducked; out.duckHeld = !!p.duckHeld; out.jumpHeld = !!p.jumpHeld; out.onLadder = !!p.onLadder; out.jumped = !!p.jumped;
  out.groundNormal = p.groundNormal ? p.groundNormal.slice() : null; out.ladderNormal = p.onLadder && p.ladderNormal ? p.ladderNormal.slice() : null;
  out.groundTri = p.groundTri ?? -1; out.duckAmount = p.duckAmount; out.duckSpeed = p.duckSpeed ?? 8; out.stamina = p.stamina; out.velocityModifier = p.velocityModifier;
  out.fallVelocity = p.fallVelocity || 0; out.tags = (p.tags || []).map((t) => t.slice());
  return out;
}
// Puts a movement state back on a PlayerMovement.
export function loadMove(p, s) {
  p.origin = s.origin.slice(); p.velocity = s.velocity.slice();
  p.onGround = s.onGround; p.ducked = s.ducked; p.duckHeld = s.duckHeld; p.jumpHeld = s.jumpHeld; p.onLadder = s.onLadder; p.jumped = s.jumped;
  p.groundNormal = s.groundNormal ? s.groundNormal.slice() : null; if (s.ladderNormal) p.ladderNormal = s.ladderNormal.slice();
  p.groundTri = s.groundTri >= 0 ? s.groundTri : undefined; p.duckAmount = s.duckAmount; p.duckSpeed = s.duckSpeed; p.stamina = s.stamina;
  p.velocityModifier = s.velocityModifier; p.fallVelocity = s.fallVelocity; p.tags = s.tags.map((t) => t.slice());
}
function writeMove(w, s) {
  for (const v of s.origin) w.f64(v);
  for (const v of s.velocity) w.f64(v);
  w.byte((s.onGround ? MV.GROUND : 0) | (s.ducked ? MV.DUCKED : 0) | (s.duckHeld ? MV.DUCKHELD : 0) | (s.jumpHeld ? MV.JUMPHELD : 0) | (s.onLadder ? MV.LADDER : 0)
    | (s.jumped ? MV.JUMPED : 0) | (s.groundNormal ? MV.GN : 0) | (s.ladderNormal ? MV.LN : 0));
  w.i32(s.groundTri ?? -1);
  w.f32(s.duckAmount); w.f32(s.duckSpeed); w.f32(s.stamina); w.f32(s.velocityModifier); w.f32(s.fallVelocity);
  if (s.groundNormal) for (const v of s.groundNormal) w.f32(v);
  if (s.ladderNormal) for (const v of s.ladderNormal) w.f32(v);
  w.byte(Math.min(8, s.tags.length));
  for (const t of s.tags.slice(0, 8)) { w.f32(t[0]); w.f32(t[1]); w.f32(t[2]); }
}
function readMove(r) {
  const s = { origin: [r.f64(), r.f64(), r.f64()], velocity: [r.f64(), r.f64(), r.f64()] };
  const b = r.byte();
  Object.assign(s, { onGround: !!(b & MV.GROUND), ducked: !!(b & MV.DUCKED), duckHeld: !!(b & MV.DUCKHELD), jumpHeld: !!(b & MV.JUMPHELD), onLadder: !!(b & MV.LADDER), jumped: !!(b & MV.JUMPED) });
  s.groundTri = r.i32();
  s.duckAmount = r.f32(); s.duckSpeed = r.f32(); s.stamina = r.f32(); s.velocityModifier = r.f32(); s.fallVelocity = r.f32();
  s.groundNormal = b & MV.GN ? [r.f32(), r.f32(), r.f32()] : null;
  s.ladderNormal = b & MV.LN ? [r.f32(), r.f32(), r.f32()] : null;
  s.tags = [];
  for (let n = r.byte(); n > 0; n--) s.tags.push([r.f32(), r.f32(), r.f32()]);
  return s;
}
// Weapon slots by number (WHEEL's names: weapons.js).
export const SLOTS = ['primary', 'secondary', 'knife', 'taser', 'c4', ...NADE_ORDER.map((id) => 'g_' + id)];
// The weapons block: what's held, each gun (its slot, id, whose look, magazine and reserve, its modes), money, armour, the kit,
// the bomb and the grenades.
// weapons: { active, guns: [{ slot, wid, skin, clip, reserve, silenced, burst, zoom }], money, armor, helmet, kit, c4, nades: { id: n }, team }
function writeWeapons(w, x) {
  w.byte(Math.max(255 * !x.active, SLOTS.indexOf(x.active)) & 255);
  w.byte(x.guns.length);
  for (const g of x.guns) {
    w.byte(SLOTS.indexOf(g.slot)); writeWid(w, g.wid); w.byte(g.skin ?? 255); w.byte(Math.max(0, Math.min(255, g.clip | 0))); w.u16(Math.max(0, g.reserve | 0));
    w.byte((g.silenced ? 1 : 0) | (g.burst ? 2 : 0) | ((g.zoom & 3) << 2));
  }
  w.u16(Math.max(0, Math.min(65535, x.money | 0))); w.byte(Math.ceil(x.armor)); w.byte((x.helmet ? 1 : 0) | (x.kit ? 2 : 0) | (x.c4 ? 4 : 0) | (x.team === 'T' ? 8 : 0));
  for (const id of NADE_ORDER) w.byte(x.nades?.[id] || 0);
}
function readWeapons(r) {
  const a = r.byte(), x = { active: SLOTS[a] || null, guns: [] };
  for (let n = r.byte(); n > 0; n--) {
    const slot = SLOTS[r.byte()], wid = readWid(r), skin = r.byte(), clip = r.byte(), reserve = r.u16(), f = r.byte();
    x.guns.push({ slot, wid, skin, clip, reserve, silenced: !!(f & 1), burst: !!(f & 2), zoom: (f >> 2) & 3 });
  }
  x.money = r.u16(); x.armor = r.byte();
  const b = r.byte();
  x.helmet = !!(b & 1); x.kit = !!(b & 2); x.c4 = !!(b & 4); x.team = b & 8 ? 'T' : 'CT';
  x.nades = {};
  for (const id of NADE_ORDER) { const n = r.byte(); if (n) x.nades[id] = n; }
  return x;
}
// own: { ack (seq, low 16 bits), depth, flags, move (moveState), weapons?, events }
export function writeOwn(w, o) {
  w.u16(o.ack); w.byte(Math.min(255, o.depth)); w.byte(o.flags | (o.weapons ? OWN.WEAPONS : 0));
  writeMove(w, o.move);
  if (o.weapons) writeWeapons(w, o.weapons);
  writeEvents(w, o.events || []);
}
export function readOwn(r) {
  const o = { ack: r.u16(), depth: r.byte(), flags: r.byte() };
  o.move = readMove(r);
  o.weapons = o.flags & OWN.WEAPONS ? readWeapons(r) : null;
  o.events = readEvents(r);
  return o;
}

// ---- frames --------------------------------------------------------------------------------------------------------------
// The host's bundle: the shared part and each client's own. owns: Map(slot -> Uint8Array).
export function bundleFrame(tick, shared, owns, w = new Writer(8192)) {
  w.reset().byte(0x10).u32(tick).u16(shared.length).bytes(shared);
  w.byte(owns.size);
  for (const [slot, own] of owns) { w.byte(slot); w.u16(own.length); w.bytes(own); }
  return w.done();
}
// A keyframe for one client, by unicast: [0x11][slot][1][tick][sharedLen][shared][ownLen][own].
export function keyFrame(slot, tick, shared, own, w = new Writer(4096)) {
  w.reset().byte(0x11).byte(slot).byte(1).u32(tick).u16(shared.length).bytes(shared).u16(own.length).bytes(own);
  return w.done();
}
export function jsonFrame(slot, msg) {
  const body = utf8(JSON.stringify(msg));
  const w = new Writer(body.length + 8);
  w.byte(0x11).byte(slot).byte(2).u16(body.length).bytes(body);
  return w.done();
}
// A frame for a client (from the relay): → { kind: 'snap' | 'key' | 'json', tick, shared (Reader), own (Reader | null), msg }
export function readClientFrame(data) {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data), r = new Reader(u);
  const t = r.byte();
  if (t === 0x90) {
    const tick = r.u32(), len = r.u16(), shared = r.sub(len);
    return { kind: 'snap', tick, shared, own: r.left > 0 ? r.sub(r.left) : null };
  }
  if (t === 0x91) {
    const kind = r.byte();
    if (kind === 1) { const tick = r.u32(), len = r.u16(), shared = r.sub(len), ol = r.u16(); return { kind: 'key', tick, shared, own: ol ? r.sub(ol) : null }; }
    if (kind === 2) { const len = r.u16(); return { kind: 'json', msg: JSON.parse(dec.decode(r.bytes(len))) }; }
  }
  return null;
}
