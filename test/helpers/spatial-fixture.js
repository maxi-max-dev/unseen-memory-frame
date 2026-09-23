'use strict';
const zlib = require('node:zlib');
const { crc32 } = require('../../server/spatial-sog');
const SCENE = 'GS3DC58c4f791ace58141dc9720044e4e771f';
const SHARE = 'https://app.insta360.com/3dspace/detail/' + SCENE;
const ASSET = 'https://insta360-app-hz.oss-cn-hangzhou.aliyuncs.com/model.sog?Signature=must-never-persist';
function webp(width = 1, height = 1) {
  // Synthetic WebP header for container/metadata validation, not renderer acceptance.
  const b = Buffer.alloc(26); b.write('RIFF'); b.writeUInt32LE(18, 4); b.write('WEBPVP8L', 8); b.writeUInt32LE(5, 16); b[20] = 0x2f; b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21); return b;
}
function entries(metaChange = {}, texture = webp()) {
  const meta = { version: 2, count: 1, means: { mins: [0,0,0], maxs: [1,1,1], files: ['means_l.webp','means_u.webp'] },
    scales: { codebook: Array(256).fill(0), files: ['scales.webp'] }, quats: { files: ['quats.webp'] }, sh0: { codebook: Array(256).fill(0), files: ['sh0.webp'] }, ...metaChange };
  return [['meta.json', Buffer.from(JSON.stringify(meta))], ...['means_l.webp','means_u.webp','scales.webp','quats.webp','sh0.webp'].map(name => [name, texture])];
}
function zip(items = entries(), { method = 0, descriptor = false } = {}) {
  let position = 0; const local = [], central = [];
  for (const [name, data] of items) {
    const n = Buffer.from(name), encoded = method === 8 ? zlib.deflateRawSync(data) : data, crc = crc32(data), flags = descriptor ? 8 : 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(method, 8); h.writeUInt16LE(n.length, 26);
    if (!descriptor) { h.writeUInt32LE(crc, 14); h.writeUInt32LE(encoded.length, 18); h.writeUInt32LE(data.length, 22); }
    const d = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) { d.writeUInt32LE(0x08074b50); d.writeUInt32LE(crc, 4); d.writeUInt32LE(encoded.length, 8); d.writeUInt32LE(data.length, 12); }
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(encoded.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(position, 42);
    local.push(h, n, encoded, d); central.push(c, n); position += h.length + n.length + encoded.length + d.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...local, directory, end]);
}
function page(scene = SCENE, overrides = {}) {
  return '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { taskDetail: { taskOrderNo: scene, isPrivate: 0, title: '测试空间', outputs: [{ type: 'model', fileFormat: 'sog', url: ASSET }], ...overrides } } } }) + '</script>';
}

module.exports = { SCENE, SHARE, ASSET, webp, entries, zip, page };
