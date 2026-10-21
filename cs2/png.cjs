// Minimal PNG decoder/encoder (8/16-bit, non-interlaced) for build scripts and channel checks.
const zlib = require('zlib');
const fs = require('fs');

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, depth = 8, ctype = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; if (data[12]) throw new Error('interlaced PNG'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error('unsupported PNG color type ' + ctype);
  const bpp = ch * (depth / 8), stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { width: w, height: h, channels: ch, depth, data: out };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
// 8-bit RGBA encoder.
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// Box-downscales PNG files in place so their longest side is at most `max` (8-bit only; others are left alone).
// Used where Electron's native image resizer isn't available (the dev server).
async function shrinkPNGs(files, max) {
  for (const f of files) {
    try {
      const img = decodePNG(fs.readFileSync(f));
      if (img.depth !== 8 || Math.max(img.width, img.height) <= max) continue;
      const k = Math.ceil(Math.max(img.width, img.height) / max);
      const w = Math.max(1, Math.floor(img.width / k)), h = Math.max(1, Math.floor(img.height / k)), ch = img.channels;
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const acc = [0, 0, 0, 0];
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
          const o = ((y * k + dy) * img.width + x * k + dx) * ch;
          const g = img.data[o];
          if (ch === 1) { acc[0] += g; acc[1] += g; acc[2] += g; acc[3] += 255; }
          else if (ch === 2) { acc[0] += g; acc[1] += g; acc[2] += g; acc[3] += img.data[o + 1]; }
          else { acc[0] += g; acc[1] += img.data[o + 1]; acc[2] += img.data[o + 2]; acc[3] += ch === 4 ? img.data[o + 3] : 255; }
        }
        for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(acc[c] / (k * k));
      }
      fs.writeFileSync(f, encodePNG(w, h, out));
    } catch {}
    await new Promise((r) => setImmediate(r));
  }
}

module.exports = { decodePNG, encodePNG, shrinkPNGs };
