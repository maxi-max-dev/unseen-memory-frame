// Deterministic neutral geometric PNGs. No photographs, external input or EXIF.
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const names = ['demo', 'couple1', 'couple2', 'daughter', 'dil', 'family', 'grandma', 'grandpa', 'grandson', 'house', 'son', 'today'];
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, checksum]);
}
function picture(index) {
  const width = 640, height = 480, pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sun = (x - 462) ** 2 + (y - 128) ** 2 < 48 ** 2;
    const ridge = y > 310 - Math.sin(x / 90 + index / 3) * 45;
    const near = y > 391 - Math.sin(x / 115 + 2 + index / 3) * 37;
    const rgb = sun ? [247, 197, 112] : near ? [98 + index * 2, 137, 124] : ridge ? [145, 173, 163] : [226, 237, 242];
    const offset = y * (width * 3 + 1) + 1 + x * 3; pixels.set(rgb, offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export async function generate(root) {
  const dir = path.join(root, 'server/public/assets'); await fs.mkdir(dir, { recursive: true });
  for (let index = 0; index < names.length; index++) await fs.writeFile(path.join(dir, names[index] + '.png'), picture(index));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('Neutral demo PNG assets generated.');
}
