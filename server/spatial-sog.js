'use strict';
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { SpatialError } = require('./spatial-network');
const inflate = promisify(zlib.inflateRaw);
const bad = () => { throw new SpatialError('空间模型格式无效或超出安全限制'); };
const LIMITS = { file: 64 * 1024 * 1024, expanded: 128 * 1024 * 1024, entry: 32 * 1024 * 1024, count: 2000000, pixels: 16 * 1024 * 1024 };
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function dimensions(buffer) {
  if (buffer.length < 26 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) bad();
  let offset = 12, result, extended;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > buffer.length) bad();
    if (type === 'VP8L') {
      if (result || size < 5 || buffer[start] !== 0x2f) bad();
      const bits = buffer.readUInt32LE(start + 1);
      if (bits >>> 29) bad();
      result = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (type === 'VP8X') {
      if (extended || size !== 10 || buffer[start] & 2) bad();
      extended = { width: buffer.readUIntLE(start + 4, 3) + 1, height: buffer.readUIntLE(start + 7, 3) + 1 };
    } else if (!['ICCP', 'EXIF', 'XMP '].includes(type)) bad();
    offset = start + size + (size & 1);
  }
  if (offset !== buffer.length || !result || (extended && (extended.width !== result.width || extended.height !== result.height))) bad();
  if (result.width > 8192 || result.height > 8192 || result.width * result.height > LIMITS.pixels) bad();
  return result;
}
const finite = (value, length, max = 1000) => Array.isArray(value) && value.length === length && value.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= max);
function validateMeta(meta, entries) {
  if (!meta || meta.version !== 2 || !Number.isInteger(meta.count) || meta.count < 1 || meta.count > LIMITS.count) bad();
  if (!finite(meta.means?.mins, 3, 100) || !finite(meta.means?.maxs, 3, 100) || meta.means.mins.some((x, i) => x > meta.means.maxs[i])) bad();
  if (!finite(meta.scales?.codebook, 256, 40) || !finite(meta.sh0?.codebook, 256)) bad();
  const groups = { means: ['means_l.webp', 'means_u.webp'], scales: ['scales.webp'], quats: ['quats.webp'], sh0: ['sh0.webp'] };
  if (meta.shN) {
    if (![1,2,3].includes(meta.shN.bands) || !Number.isInteger(meta.shN.count) || meta.shN.count < 1 || meta.shN.count > 65536 || !finite(meta.shN.codebook, 256)) bad();
    groups.shN = ['shN_centroids.webp', 'shN_labels.webp'];
  }
  const names = ['meta.json'];
  for (const [group, files] of Object.entries(groups)) {
    if (JSON.stringify(meta[group]?.files) !== JSON.stringify(files)) bad();
    names.push(...files);
  }
  if (entries.size !== names.length || names.some(name => !entries.has(name))) bad();
  return names;
}
async function validateSog(filename, { signal, limits = LIMITS } = {}) {
  const file = await fs.open(filename, 'r');
  try {
    const size = (await file.stat()).size;
    if (size < 22 || size > limits.file) bad();
    async function read(position, length) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(length) || length < 0 || position < 0 || position + length > size) bad();
      const buffer = Buffer.alloc(length); const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead !== length) bad(); return buffer;
    }
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 20)) bad();
    const count = tail.readUInt16LE(end + 10), cdSize = tail.readUInt32LE(end + 12), cdStart = tail.readUInt32LE(end + 16);
    if (count < 6 || count > 8 || count !== tail.readUInt16LE(end + 8) || cdSize > 32768 || cdStart + cdSize !== size - tail.length + end) bad();
    const central = await read(cdStart, cdSize), entries = new Map();
    let offset = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) bad();
      const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10), crc = central.readUInt32LE(offset + 16), compressed = central.readUInt32LE(offset + 20), uncompressed = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28), extraLength = central.readUInt16LE(offset + 30), commentLength = central.readUInt16LE(offset + 32), local = central.readUInt32LE(offset + 42);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || flags & ~0x808 || ![0,8].includes(method) || central.readUInt16LE(offset + 34)) bad();
      const name = central.toString('utf8', offset + 46, offset + 46 + nameLength);
      const mode = (central.readUInt32LE(offset + 38) >>> 16) & 0xf000;
      if (!/^(meta\.json|means_[lu]\.webp|quats\.webp|scales\.webp|sh0\.webp|shN_(centroids|labels)\.webp)$/.test(name) || entries.has(name) || mode && mode !== 0x8000) bad();
      if (!compressed || !uncompressed || uncompressed > limits.entry || uncompressed > compressed * 100 || (method === 0 && compressed !== uncompressed) || (name === 'meta.json' && uncompressed > 65536)) bad();
      expanded += uncompressed; if (expanded > limits.expanded) bad();
      const header = await read(local, 30);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== method || header.readUInt16LE(26) !== nameLength) bad();
      const localName = (await read(local + 30, nameLength)).toString('utf8');
      if (localName !== name) bad();
      const dataOffset = local + 30 + nameLength + header.readUInt16LE(28), dataEnd = dataOffset + compressed;
      if (dataEnd > cdStart) bad();
      let recordEnd = dataEnd;
      if (flags & 8) {
        const descriptor = await read(dataEnd, 16);
        const start = descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
        if (descriptor.readUInt32LE(start) !== crc || descriptor.readUInt32LE(start + 4) !== compressed || descriptor.readUInt32LE(start + 8) !== uncompressed) bad();
        recordEnd += start + 12;
      } else if (header.readUInt32LE(14) !== crc || header.readUInt32LE(18) !== compressed || header.readUInt32LE(22) !== uncompressed) bad();
      if (recordEnd > cdStart) bad();
      entries.set(name, { local, recordEnd, dataOffset, compressed, uncompressed, method, crc }); offset = next;
    }
    if (offset !== central.length) bad();
    const ranges = [...entries.values()].sort((a, b) => a.local - b.local);
    if (ranges[0].local !== 0 || ranges.some((e, i) => i && e.local !== ranges[i - 1].recordEnd) || ranges.at(-1).recordEnd !== cdStart) bad();
    async function extract(name) {
      const e = entries.get(name); if (!e) bad();
      const compressed = await read(e.dataOffset, e.compressed);
      let output; try { output = e.method === 0 ? compressed : await inflate(compressed, { maxOutputLength: e.uncompressed }); } catch { bad(); }
      signal?.throwIfAborted();
      if (output.length !== e.uncompressed || crc32(output) !== e.crc) bad();
      return output;
    }
    let meta; try { meta = JSON.parse((await extract('meta.json')).toString('utf8')); } catch { bad(); }
    const names = validateMeta(meta, entries), textures = {};
    let decoded = 0;
    for (const name of names.filter(x => x !== 'meta.json')) {
      const d = dimensions(await extract(name)); textures[name] = d;
      decoded += d.width * d.height * 4; if (decoded > limits.expanded) bad();
      if (name !== 'shN_centroids.webp') {
        if (d.width * d.height < meta.count || d.width * d.height > Math.max(meta.count * 2, 4096)) bad();
        const base = textures['means_l.webp']; if (d.width !== base.width || d.height !== base.height) bad();
      } else {
        const coeffs = [0,3,8,15][meta.shN.bands];
        if (d.width * d.height < meta.shN.count * coeffs || d.width * d.height > Math.max(meta.shN.count * coeffs * 2, 4096)) bad();
      }
    }
    return { version: 2, count: meta.count, bands: meta.shN?.bands || 0, expandedBytes: expanded, decodedBytes: decoded };
  } finally { await file.close(); }
}
module.exports = { validateSog, LIMITS, crc32, dimensions };
