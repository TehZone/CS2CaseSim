// Renders build/icon.png (256x256): gold hexagon + star on a dark rounded tile. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256, SS = 4;
const px = Buffer.alloc(N * N * 4);

const hex = [[32, 80], [128, 32], [224, 80], [224, 176], [128, 224], [32, 176]];
const star = [];
for (let i = 0; i < 10; i++) {
  const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 26 : 62;
  star.push([128 + Math.cos(a) * r, 132 + Math.sin(a) * r]);
}
function segDist(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
function inPoly(x, y, p) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}
function inRoundRect(x, y, r = 46) {
  const cx = Math.min(Math.max(x, r), N - r), cy = Math.min(Math.max(y, r), N - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
function sample(x, y) {
  if (!inRoundRect(x, y)) return null;
  let d = Infinity;
  for (let i = 0; i < hex.length; i++) d = Math.min(d, segDist(x, y, hex[i], hex[(i + 1) % hex.length]));
  const gold = [242 + (y / N) * 10, 178 - (y / N) * 40, 27];
  if (d < 10 || inPoly(x, y, star)) return gold;
  const t = y / N;
  return [20 - t * 8, 27 - t * 10, 37 - t * 12];
}
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = (y * N + x) * 4;
    if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; }
    px[o + 3] = (a / (SS * SS)) * 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png);
console.log('wrote build/icon.png');
