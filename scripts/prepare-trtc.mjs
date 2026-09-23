// Fetch one pinned official package. Extract named regular files in memory only;
// no archive paths are ever used as filesystem destinations and no scripts run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const url = 'https://registry.npmjs.org/trtc-sdk-v5/-/trtc-sdk-v5-5.19.2.tgz';
const expected = 'RNz7ZzcqAt5+95SKj6i6Vo+Zjg1BIWeO7fm5G7fkUgv3N9hRAkHNK6qMTDRhA+G2/sbAWXmaqiMaAQ82BPF07A==';
const response = await fetch(url, { signal: AbortSignal.timeout(90000), redirect: 'error' });
if (!response.ok) throw Error('Official SDK package download failed.');
const chunks = []; let count = 0;
for await (const bytes of response.body) { count += bytes.length; if (count > 32 * 1024 * 1024) throw Error('SDK archive exceeds size limit.'); chunks.push(bytes); }
const compressed = Buffer.concat(chunks);
if (createHash('sha512').update(compressed).digest('base64') !== expected) throw Error('Official SDK archive integrity mismatch.');
const archive = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }), selected = new Map();
const outputs = new Map([['package/trtc.esm.js', 'trtc-5.19.2.mjs']]);
for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512);
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
  if (!name) break;
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw Error('Invalid SDK archive structure.');
  if (outputs.has(name)) {
    if (![0, 48].includes(header[156]) || selected.has(name)) throw Error('SDK entry must be one unique regular file.');
    selected.set(name, archive.subarray(offset + 512, offset + 512 + size));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (selected.size !== outputs.size) throw Error('Pinned SDK module missing from archive.');
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/public/vendor');
for (const [name, dest] of outputs) await fs.writeFile(path.join(dir, dest), selected.get(name));
console.log('TRTC 5.19.2 prepared from the verified official package. Realtime remains disabled until configured.');
