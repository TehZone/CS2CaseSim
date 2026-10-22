// Minimal OpenEXR reader for the files Source 2 Viewer writes (scanline images, uncompressed or ZIP, half or float
// channels). Used for CS2's HDR textures: map lightmaps and skies.
const fs = require('fs');
const zlib = require('zlib');

function header(buf) {
  if (buf.readUInt32LE(0) !== 0x01312f76) throw new Error('not an EXR file');
  const h = {};
  let p = 8;
  for (;;) {
    let e = buf.indexOf(0, p);
    const name = buf.toString('latin1', p, e);
    p = e + 1;
    if (!name) break;
    e = buf.indexOf(0, p);
    const type = buf.toString('latin1', p, e);
    p = e + 1;
    const size = buf.readUInt32LE(p);
    p += 4;
    const v = buf.subarray(p, p + size);
    p += size;
    if (type === 'chlist') {
      const chans = [];
      for (let q = 0; v[q];) {
        const z = v.indexOf(0, q);
        chans.push({ name: v.toString('latin1', q, z), type: v.readInt32LE(z + 1) });
        q = z + 1 + 16;
      }
      h[name] = chans;
    } else if (type === 'compression') h[name] = v[0];
    else if (type === 'box2i') h[name] = [0, 4, 8, 12].map((o) => v.readInt32LE(o));
  }
  h.offsetTable = p;
  return h;
}

// Undoes EXR's ZIP preprocessing: byte delta predictor, then the two-halves interleave.
function unzipChunk(data, size) {
  const t = zlib.inflateSync(data);
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 255;
  const out = Buffer.allocUnsafe(t.length);
  const half = (t.length + 1) >> 1;
  for (let i = 0, a = 0, b = half; i < t.length; i += 2) {
    out[i] = t[a++];
    if (i + 1 < t.length) out[i + 1] = t[b++];
  }
  return out.length === size ? out : out.subarray(0, size);
}

const halfToFloat = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    table[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return table;
})();

// Reads an EXR into { width, height, rgba: Float32Array } (missing channels: 0, alpha 1). `onRow(y, rowRGBA)` lets
// callers stream big images instead of keeping them whole (then rgba is null).
function readEXR(file, { onRow = null } = {}) {
  const buf = fs.readFileSync(file);
  const h = header(buf);
  const [x0, y0, x1, y1] = h.dataWindow;
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  const linesPer = { 0: 1, 2: 1, 3: 16 }[h.compression];
  if (!linesPer) throw new Error('unsupported EXR compression ' + h.compression);
  const chans = h.channels; // stored in alphabetical order
  const slot = { R: 0, G: 1, B: 2, A: 3 };
  const bytes = chans.map((c) => (c.type === 1 ? 2 : 4));
  const lineBytes = bytes.reduce((s, b) => s + b * width, 0);
  const chunks = Math.ceil(height / linesPer);
  const rgba = onRow ? null : new Float32Array(width * height * 4);
  const row = new Float32Array(width * 4);
  for (let c = 0; c < chunks; c++) {
    const off = Number(buf.readBigUInt64LE(h.offsetTable + c * 8));
    const y = buf.readInt32LE(off) - y0, size = buf.readInt32LE(off + 4);
    const lines = Math.min(linesPer, height - y);
    const raw = buf.subarray(off + 8, off + 8 + size);
    const data = h.compression === 0 || size === lines * lineBytes ? raw : unzipChunk(raw, lines * lineBytes);
    let p = 0;
    for (let l = 0; l < lines; l++) {
      row.fill(0);
      for (let i = 3; i < row.length; i += 4) row[i] = 1;
      chans.forEach((ch, k) => {
        const s = slot[ch.name];
        for (let x = 0; x < width; x++) {
          const v = bytes[k] === 2 ? halfToFloat[data.readUInt16LE(p)] : data.readFloatLE(p);
          p += bytes[k];
          if (s !== undefined) row[x * 4 + s] = v;
        }
      });
      if (onRow) onRow(y + l, row);
      else rgba.set(row, (y + l) * width * 4);
    }
  }
  return { width, height, rgba };
}

module.exports = { readEXR };
