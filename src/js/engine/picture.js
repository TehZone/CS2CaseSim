// Profile pictures players pick themselves (Edit profile): square, 184 x 184 like Steam's full avatar, a WebP or a PNG of
// 64 KB at most. The game crops and shrinks whatever the player chose (a PNG, JPEG, WebP, or a GIF's first frame) and
// encodes it itself (src/js/faces.js); this checks what it made, the same way offline (the save's copy: actions.js
// persona.set, the admin panel's save check) and on the server (server/social.mjs), which trusts nothing a game sends: the
// type by its first bytes, the size from its header, nothing animated, no metadata (a photo's EXIF can say where it was
// taken), nothing after the picture's end, and the size cap. Pure, and nothing is decoded: a browser draws it, in an <img>.
export const PIC_SIZE = 184;
export const PIC_MAX = 64 * 1024;
export const PIC_TYPES = { png: 'image/png', webp: 'image/webp' };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

const BROKEN = 'That picture is damaged or not a PNG or WebP';
const MOVING = 'A profile picture can\'t be animated';
const EXTRA = 'A profile picture can\'t carry metadata';

// Only the chunks a picture is made of, which a browser's canvas writes (Chromium's: a PNG's IHDR, IDAT and IEND; a WebP's
// VP8X, its colour profile ICCP, ALPH and VP8 or VP8L), and in a PNG what only says how to show its colours (a palette,
// transparency, gamma, colour space, pixel size). Anything else, text, EXIF, XMP or a chunk of anyone's own, is refused:
// a picture here carries nothing but itself, so it can't hold where a photo was taken or anyone's files. A colour profile is
// a few hundred bytes (Chromium's sRGB one: 456); at most ICC_MAX, and every PNG chunk but IDAT at most SMALL.
const ICC_MAX = 4096, SMALL = 1024;
const PNG_OK = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'iCCP']);

// A PNG: its chunks from IHDR to IEND, and nothing after.
function png(b) {
  let i = 8, w = 0, h = 0;
  while (i + 12 <= b.length) {
    const len = u32be(b, i), type = tag(b, i + 4);
    if (len > b.length - i - 12) return { error: BROKEN };
    if (i === 8) {
      if (type !== 'IHDR' || len !== 13) return { error: BROKEN };
      w = u32be(b, 16); h = u32be(b, 20);
    } else if (type === 'IHDR') return { error: BROKEN };
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return { error: MOVING };
    if (!PNG_OK.has(type) || (type === 'iCCP' ? len > ICC_MAX : type !== 'IDAT' && len > SMALL)) return { error: EXTRA };
    i += 12 + len;
    if (type === 'IEND') return i === b.length ? { type: 'png', w, h } : { error: BROKEN };
  }
  return { error: BROKEN };
}

// A WebP image chunk's own size (VP8: a key frame's; VP8L: its header's), or null if it isn't one.
function frameSize(b, type, at, len) {
  if (type === 'VP8 ') {
    if (len < 10 || (b[at] & 1) || b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) return null;
    return { w: (b[at + 6] | (b[at + 7] << 8)) & 0x3fff, h: (b[at + 8] | (b[at + 9] << 8)) & 0x3fff };
  }
  if (type === 'VP8L') {
    if (len < 5 || b[at] !== 0x2f) return null;
    const v = u32le(b, at + 1);
    return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

// A WebP: a RIFF of exactly its length, its chunks to the end. Simple: one image chunk (VP8 or VP8L), nothing else. Extended
// (VP8X: its canvas): a colour profile, an alpha chunk and one image chunk the canvas's size.
function webp(b) {
  if (b.length < 30 || u32le(b, 4) + 8 !== b.length) return { error: BROKEN };
  const chunks = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = tag(b, i), len = u32le(b, i + 4);
    if (type === 'ANIM' || type === 'ANMF') return { error: MOVING };
    if (type === 'EXIF' || type === 'XMP ') return { error: EXTRA };
    if (len > b.length - i - 8) return { error: BROKEN };
    chunks.push({ type, at: i + 8, len });
    i += 8 + len + (len & 1);
  }
  if (i !== b.length || !chunks.length) return { error: BROKEN };
  const [first, ...rest] = chunks;
  if (first.type !== 'VP8X') {
    const f = frameSize(b, first.type, first.at, first.len);
    if (!f) return { error: BROKEN };
    return rest.length ? { error: EXTRA } : { type: 'webp', w: f.w, h: f.h };
  }
  if (first.len < 10) return { error: BROKEN };
  const flags = b[first.at];
  if (flags & 0x02) return { error: MOVING };
  if (flags & 0x0c) return { error: EXTRA };
  const w = u24le(b, first.at + 4) + 1, h = u24le(b, first.at + 7) + 1;
  let img = null;
  for (const c of rest) {
    if (c.type === 'ICCP' || c.type === 'ALPH') {
      if (img) return { error: BROKEN }; // (they come before the image)
      if (c.type === 'ICCP' && c.len > ICC_MAX) return { error: EXTRA };
      continue;
    }
    if (c.type !== 'VP8 ' && c.type !== 'VP8L') return { error: EXTRA };
    if (img) return { error: BROKEN };
    img = frameSize(b, c.type, c.at, c.len);
    if (!img) return { error: BROKEN };
  }
  // (A canvas that says one size over an image of another is no picture of that size.)
  if (!img || img.w !== w || img.h !== h) return { error: BROKEN };
  return { type: 'webp', w, h };
}

// What a picture's bytes are: { type: 'png' | 'webp', w, h } or { error } (what's wrong with it, to show the player).
export function pictureInfo(b) {
  if (!(b instanceof Uint8Array) || !b.length) return { error: BROKEN };
  if (b.length > PIC_MAX) return { error: `A profile picture can be up to ${PIC_MAX / 1024} KB` };
  if (PNG_SIG.every((x, i) => b[i] === x)) return png(b);
  if (b.length >= 12 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WEBP') return webp(b);
  return { error: 'A profile picture must be a PNG or WebP' };
}
// What's wrong with a picture to keep ('' when nothing): pictureInfo's checks, and its size, 184 x 184.
export function pictureProblem(b) {
  const p = pictureInfo(b);
  if (p.error) return p.error;
  return p.w === PIC_SIZE && p.h === PIC_SIZE ? '' : `A profile picture must be ${PIC_SIZE} x ${PIC_SIZE} pixels`;
}

// An offline save keeps its picture as a data: URL (an <img> draws it as it is). Its bytes, or null for anything that isn't
// a PNG or WebP data: URL short enough to be within the size cap.
const DATA_URL = /^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
export function dataUrlBytes(url) {
  const m = typeof url === 'string' && url.length <= 40 + Math.ceil(PIC_MAX / 3) * 4 ? DATA_URL.exec(url) : null;
  if (!m) return null;
  try {
    const bin = globalThis.atob(m[2]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}
// What's wrong with a data: URL as a profile picture ('' when nothing): its bytes' (pictureProblem), and the type it says
// must be the one they are.
export function dataUrlProblem(url) {
  const b = dataUrlBytes(url);
  if (!b) return 'A profile picture must be a PNG or WebP';
  const bad = pictureProblem(b);
  if (bad) return bad;
  return url.startsWith(`data:${PIC_TYPES[pictureInfo(b).type]};`) ? '' : BROKEN;
}
// A picture's bytes as a data: URL (the type from what they are), or null when they aren't a picture to keep.
export function bytesToDataUrl(b) {
  if (pictureProblem(b)) return null;
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${PIC_TYPES[pictureInfo(b).type]};base64,${globalThis.btoa(bin)}`;
}
