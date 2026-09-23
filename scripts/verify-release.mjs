import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = await fs.readFile(path.join(root, 'SHA256SUMS'), 'utf8');
let checked = 0;
for (const line of manifest.trim().split('\n')) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match || match[2].includes('\\') || match[2].split('/').some(x => !x || x === '..') || path.isAbsolute(match[2])) throw Error('Invalid manifest path.');
  const digest = createHash('sha256').update(await fs.readFile(path.join(root, match[2]))).digest('hex');
  if (digest !== match[1]) throw Error('Release file changed: ' + match[2]);
  checked++;
}
console.log(`Verified ${checked} initial release files. This checks bytes, not a cryptographic publisher signature.`);
