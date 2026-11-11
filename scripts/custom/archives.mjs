// Archives the Workshop importer reads (scripts/import-workshop.mjs), with no dependencies:
//   zip: an author's files, or a CS:GO-era Workshop upload (myweaponfinishes/<name>.zip: workbench .txt, .tga, .vtf).
//   VPK: a Steam Workshop item Steam downloaded (content/730/<id>/<id>_dir.vpk), listed to say what it holds.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// What a zip may unpack to, at most (an author's 4K textures are 64 MiB each, uncompressed).
const ZIP_MAX_ENTRY = 1 << 30, ZIP_MAX_TOTAL = 4 * 2 ** 30, ZIP_MAX_FILES = 20000;

// The files in a zip (STORE or DEFLATE, as Windows, 7-Zip and Steam's old uploads make them): [{ name, size, read() }].
// Throws a readable message for what it can't read (ZIP64, encrypted, other methods, damage).
export function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`${path.basename(file)} isn't a zip file`);
  const count = buf.readUInt16LE(eocd + 10), at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error(`${path.basename(file)} is a ZIP64 archive: unzip it and pass the folder`);
  const out = [];
  let p = at;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path.basename(file)} is damaged (its file list)`);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    // (Names are UTF-8 with flag bit 11, else the DOS code page: Latin-1 is close enough for file names.)
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    out.push({
      name, size: usize,
      read() {
        if (flags & 1) throw new Error(`${name} is encrypted: unzip it yourself and pass the folder`);
        if (usize > ZIP_MAX_ENTRY) throw new Error(`${name} is over 1 GiB`);
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${path.basename(file)} is damaged (${name})`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), raw = buf.subarray(start, start + csize);
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
        else throw new Error(`${name} is compressed with method ${method}: re-zip it with plain Deflate, or unzip it and pass the folder`);
        if (data.length !== usize || (zlib.crc32(data) >>> 0) !== crc) throw new Error(`${path.basename(file)} is damaged (${name})`);
        return data;
      },
    });
  }
  return out;
}

// A zip's files written under `dir` (a new, empty folder of the caller's). Entry names that would land outside it (an
// absolute path, a drive, "..") are refused, as are archives too big to be an item's files. Returns the paths written.
export function extractZip(file, dir) {
  const entries = readZip(file);
  if (entries.length > ZIP_MAX_FILES) throw new Error(`${path.basename(file)} has ${entries.length} files: that's not a finish`);
  if (entries.reduce((s, e) => s + e.size, 0) > ZIP_MAX_TOTAL) throw new Error(`${path.basename(file)} unpacks to over 4 GiB: that's not a finish`);
  const root = path.resolve(dir), written = [];
  for (const e of entries) {
    const parts = e.name.split('/').filter((x) => x && x !== '.');
    if (/^[a-z]:/i.test(e.name) || e.name.startsWith('/') || parts.includes('..') || !parts.length) throw new Error(`${path.basename(file)} has a file outside its own folder ("${e.name}"): not unpacked`);
    const to = path.join(root, ...parts);
    if (!to.startsWith(root + path.sep)) throw new Error(`${path.basename(file)} has a file outside its own folder ("${e.name}"): not unpacked`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, e.read());
    written.push(to);
  }
  return written;
}

// The files a VPK holds, from its directory file (<name>_dir.vpk, version 1 or 2): [{ path, size }]. Only the directory is
// read: nothing is unpacked.
export function listVpk(file) {
  const b = fs.readFileSync(file);
  if (b.length < 12 || b.readUInt32LE(0) !== 0x55aa1234) throw new Error(`${path.basename(file)} isn't a VPK`);
  const version = b.readUInt32LE(4), tree = b.readUInt32LE(8);
  if (version !== 1 && version !== 2) throw new Error(`${path.basename(file)} is VPK version ${version}`);
  let p = version === 2 ? 28 : 12;
  const end = Math.min(b.length, p + tree), files = [];
  const str = () => { const z = b.indexOf(0, p); if (z < 0 || z >= end) throw new Error(`${path.basename(file)} is damaged`); const s = b.toString('utf8', p, z); p = z + 1; return s; };
  for (;;) {
    const ext = str();
    if (!ext) break;
    for (;;) {
      const dir = str();
      if (!dir) break;
      for (;;) {
        const name = str();
        if (!name) break;
        // CRC (4), preload bytes (2), archive (2), offset (4), length (4), 0xffff (2), then the preload bytes.
        const preload = b.readUInt16LE(p + 4), length = b.readUInt32LE(p + 12);
        p += 18 + preload;
        files.push({ path: (dir.trim() ? dir + '/' : '') + name + (ext.trim() ? '.' + ext : ''), size: length + preload });
      }
    }
  }
  return files;
}
