'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { createApp } = require('../server/server');
const { readCloud } = require('../server/spatial-storage');
const { CHUNK_BYTES, parseRange } = require('../server/spatial-range');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const SCENE = 'GS3DC58c4f791ace58141dc9720044e4e771f';
async function fixture(t, bytes = CHUNK_BYTES * 2 + 137) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spatial-range-')); let time = Date.now();
  const app = await createApp({ dataDir: dir, setupCode: 'test', spatial: { clock: () => time } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const owner = await app.api('create', { setupCode: 'test' });
  const invite = await app.api('invite', { role: 'frame' }, owner.token), frame = await app.api('join', { invite: invite.invite });
  const sent = await app.api('send', { id: 'range-test', link: 'https://app.insta360.com/3dspace/detail/' + SCENE }, owner.token);
  // Transport-only fixture: model container validation is independently covered by import tests.
  const buffer = Buffer.alloc(bytes); for (let index = 0; index < bytes; index++) buffer[index] = index % 251;
  const file = await app.store.upload('range-test.sog', buffer);
  await app.store.put({ _id: 'sp_' + owner.room, kind: 'spatial', room: owner.room, secret: 'range-fixture-secret', entries: {
    [SCENE]: { status: 'ready', sourceURL: 'https://app.insta360.com/3dspace/detail/' + SCENE, sourceTitle: '分段传输验收', digest: hash(buffer), bytes, file }
  } });
  const asset = await app.api('spatialAsset', { id: sent.id }, owner.token);
  return { ...app, base, owner, frame, asset, id: sent.id, buffer, advance: milliseconds => { time += milliseconds; } };
}
test('range parser admits only one bounded closed interval and never rounds unsafe integers', () => {
  assert.deepEqual(parseRange('bytes=0-4194303', CHUNK_BYTES + 1), { start: 0, end: CHUNK_BYTES - 1, bytes: CHUNK_BYTES });
  for (const input of ['bytes=0-', 'bytes=-1', 'bytes=0-1,3-4', 'bytes=-1-1', 'bytes=2-1', 'bytes=0-4194304', 'bytes=9007199254740992-9007199254740993', 'items=0-1', '', null]) {
    assert.throws(() => parseRange(input, CHUNK_BYTES + 1), error => error.status === 416, String(input));
  }
  assert.throws(() => parseRange(undefined, CHUNK_BYTES + 1), error => error.status === 413);
  assert.equal(parseRange(undefined, CHUNK_BYTES), null);
});
test('HTTP: a model above 6 MB transfers as bounded 206 chunks and reassembles to its signed digest', async t => {
  const f = await fixture(t), chunks = [];
  assert.equal(f.asset.chunkBytes, CHUNK_BYTES);
  assert.equal((await fetch(f.base + f.asset.url)).status, 413);
  for (let start = 0; start < f.asset.bytes; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES - 1, f.asset.bytes - 1);
    const response = await fetch(f.base + f.asset.url, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${f.asset.bytes}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.equal(response.headers.get('accept-ranges'), 'bytes'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const buffer = Buffer.from(await response.arrayBuffer()); assert.ok(buffer.length <= CHUNK_BYTES); chunks.push(buffer);
  }
  assert.equal(hash(Buffer.concat(chunks)), f.asset.digest); assert.deepEqual(Buffer.concat(chunks), f.buffer);
  const head = await fetch(f.base + f.asset.url, { method: 'HEAD', headers: { Range: 'bytes=0-15' } });
  assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '16'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const range of ['bytes=0-', 'bytes=0-1,3-4', `bytes=0-${CHUNK_BYTES}`, `bytes=${f.asset.bytes}-${f.asset.bytes}`]) {
    const response = await fetch(f.base + f.asset.url, { headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${f.asset.bytes}`);
  }
});
test('HTTP: small model compatibility remains 200 with an optional bounded partial read', async t => {
  const f = await fixture(t, 137), full = await fetch(f.base + f.asset.url);
  assert.equal(full.status, 200); assert.equal(full.headers.get('content-range'), null);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.buffer);
  const part = await fetch(f.base + f.asset.url, { headers: { Range: 'bytes=4-12' } });
  assert.equal(part.status, 206); assert.deepEqual(Buffer.from(await part.arrayBuffer()), f.buffer.subarray(4, 13));
  // Even stale local file contents cannot expand a declared small response past its metadata bound.
  await fs.appendFile(path.join(f.store.dir, 'media', 'range-test.sog'), Buffer.alloc(CHUNK_BYTES + 1));
  assert.deepEqual(Buffer.from(await (await fetch(f.base + f.asset.url)).arrayBuffer()), f.buffer);
});
test('HTTP: every range rechecks frame revocation, account removal, expiry and message deletion', async t => {
  const f = await fixture(t), invite = await f.api('invite', { role: 'family' }, f.owner.token);
  const account = await f.api('register', { username: 'range-user', password: 'test-pass', mode: 'join', invite: invite.invite });
  const frameAsset = await f.api('spatialAsset', { id: f.id }, f.frame.token), accountAsset = await f.api('spatialAsset', { id: f.id }, account.token);
  const get = asset => fetch(f.base + asset.url, { headers: { Range: 'bytes=0-15' } });
  for (const asset of [frameAsset, accountAsset]) { const response = await get(asset); assert.equal(response.status, 206); await response.arrayBuffer(); }
  await f.api('revoke', { id: 's_' + hash(f.frame.token) }, f.owner.token);
  await f.api('revoke', { id: 's_' + hash(account.token) }, f.owner.token);
  assert.equal((await get(frameAsset)).status, 404); assert.equal((await get(accountAsset)).status, 404);
  f.advance(120001); assert.equal((await get(f.asset)).status, 404);
  const fresh = await f.api('spatialAsset', { id: f.id }, f.owner.token);
  await f.api('remove', { id: f.id }, f.owner.token); assert.equal((await get(fresh)).status, 404);
});
function fakeRequest(reply, inspect = () => {}) {
  return (url, options, receive) => {
    inspect(url, options);
    const request = new Writable({ write(_chunk, _encoding, done) { done(); } }); request.setTimeout = () => request;
    request.on('finish', () => {
      const response = Readable.from([Buffer.from(reply.body || '')]);
      response.statusCode = reply.status || 206; response.headers = reply.headers || {}; receive(response);
    });
    return request;
  };
}
const cloud = { getTempFileURL: async () => ({ fileList: [{ tempFileURL: 'https://storage.example.test/test.sog?signature=private', code: 'SUCCESS' }] }) };
const cloudOptions = { range: { start: 4, end: 6 }, lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
test('COS range read validates status, total, selected interval and length before forwarding bytes', async () => {
  const headers = { 'content-range': 'bytes 4-6/13', 'content-length': '3' };
  const stream = await readCloud(cloud, 'private-file', 13, { ...cloudOptions, request: fakeRequest({ headers, body: 'abc' }, (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=4-6'); assert.equal(options.headers['Accept-Encoding'], 'identity'); assert.equal(options.agent, false);
  }) });
  const parts = []; for await (const part of stream) parts.push(part); assert.equal(Buffer.concat(parts).toString(), 'abc');
  for (const reply of [
    { status: 200, headers }, { status: 302, headers }, { headers: { ...headers, 'content-range': 'bytes 4-6/14' } },
    { headers: { ...headers, 'content-range': 'bytes 5-7/13' } }, { headers: { 'content-length': '3' } },
    { headers: { 'content-range': headers['content-range'] } }, { headers: { ...headers, 'content-length': '4' } },
    { headers: { ...headers, 'content-encoding': 'gzip' } }
  ]) await assert.rejects(readCloud(cloud, 'private-file', 13, { ...cloudOptions, request: fakeRequest(reply) }), /读取失败/);
  for (const body of ['ab', 'abcd']) {
    const partial = await readCloud(cloud, 'private-file', 13, { ...cloudOptions, request: fakeRequest({ headers, body }) });
    await assert.rejects(async () => { for await (const _part of partial) { /* verify complete length */ } }, /大小不匹配|不完整/);
  }
  await assert.rejects(readCloud(cloud, 'private-file', CHUNK_BYTES + 1, {}), error => error.status === 413);
});
test('HTTP client cancellation aborts the active range upstream', async t => {
  const f = await fixture(t); let stopped;
  const closed = new Promise(resolve => { stopped = resolve; });
  f.store.readSpatial = async (_file, _bytes, { signal, range }) => {
    assert.equal(range.bytes, CHUNK_BYTES);
    const source = Readable.from((async function* () {
      yield Buffer.alloc(65536);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    })());
    source.on('close', stopped); return source;
  };
  const response = await fetch(f.base + f.asset.url, { headers: { Range: `bytes=0-${CHUNK_BYTES - 1}` } });
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('range upstream was not aborted')), 2000); timer.unref(); })]);
});
