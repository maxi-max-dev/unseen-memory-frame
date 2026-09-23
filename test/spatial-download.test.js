'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const ready = import('../server/public/spatial-download.mjs');
const CHUNK = 4 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const small = Buffer.from('a genuine bounded model transport test');
const big = Buffer.alloc(16324085);
for (let i = 0; i < big.length; i++) big[i] = (i * 17 + (i >>> 12)) & 255;

async function server(t, bytes, handler) {
  const requests = [];
  const instance = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range });
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : bytes.length - 1;
    const send = () => {
      res.writeHead(match ? 206 : 200, { 'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
      res.end(bytes.subarray(start, end + 1));
    };
    if (handler) handler({ req, res, start, end, send, count: requests.length }); else send();
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  const baseURL = 'http://127.0.0.1:' + instance.address().port + '/frame';
  return { baseURL, requests, asset: { format: 'sog', url: '/asset', bytes: bytes.length, digest: hash(bytes), chunkBytes: CHUNK, view: { test: 'same metadata' } } };
}

test('the actual viewer downloader assembles a 16 MB cloud-sized asset from sequential bounded 206 ranges', async t => {
  const { downloadSpatialAsset } = await ready, fixture = await server(t, big), progress = [];
  const result = await downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL, onProgress: value => progress.push(value.received) });
  assert.deepEqual(Buffer.from(result.buffer), big);assert.deepEqual(result.view, fixture.asset.view);
  assert.deepEqual(fixture.requests.map(request => request.range), ['bytes=0-4194303', 'bytes=4194304-8388607', 'bytes=8388608-12582911', 'bytes=12582912-16324084']);
  assert.equal(progress.at(-1), big.length);assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
});

test('small assets keep a single original 200 request, including older metadata without chunkBytes', async t => {
  const { downloadSpatialAsset } = await ready, fixture = await server(t, small);
  const result = await downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL });assert.deepEqual(Buffer.from(result.buffer), small);
  delete fixture.asset.chunkBytes;
  await downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL });assert.deepEqual(fixture.requests.map(request => request.range), [undefined, undefined]);
});

test('an expired signed URL refreshes once and resumes the same range without fetching earlier chunks again', async t => {
  const { downloadSpatialAsset } = await ready;
  const fixture = await server(t, big, ({ req, res, start, send }) => {
    if (req.url === '/asset' && start === CHUNK) { res.writeHead(404);res.end('expired'); } else send();
  });
  let refreshes = 0;
  const result = await downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL, refreshAsset: async () => { refreshes++;return { ...fixture.asset, url: '/refreshed' }; } });
  assert.equal(refreshes, 1);assert.deepEqual(Buffer.from(result.buffer), big);
  assert.deepEqual(fixture.requests.map(request => request.range), ['bytes=0-4194303', 'bytes=4194304-8388607', 'bytes=4194304-8388607', 'bytes=8388608-12582911', 'bytes=12582912-16324084']);
  assert.equal(fixture.requests[2].url, '/refreshed');
});

test('a refresh cannot mix changed bytes, digest or chunk contract into an in-progress model', async t => {
  const { downloadSpatialAsset } = await ready;
  const fixture = await server(t, big, ({ res, start, send }) => { if (start === CHUNK) { res.writeHead(404);res.end(); } else send(); });
  for (const change of [{ bytes: big.length - 1 }, { digest: '0'.repeat(64) }, { chunkBytes: CHUNK / 2 }]) {
    await assert.rejects(downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL, refreshAsset: async () => ({ ...fixture.asset, ...change }) }), /文件已变化/);
  }
  assert.equal(fixture.requests.length, 6);
});

test('repeated expiry and revoked access stop instead of refreshing forever', async t => {
  const { downloadSpatialAsset } = await ready;
  const fixture = await server(t, big, ({ res, start, send }) => { if (start === CHUNK) { res.writeHead(404);res.end(); } else send(); });
  let refreshes = 0;
  await assert.rejects(downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL, refreshAsset: async () => { refreshes++;return fixture.asset; } }), /无法读取/);
  assert.equal(refreshes, 1);assert.equal(fixture.requests.length, 3);
  await assert.rejects(downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL, refreshAsset: async () => { throw new Error('访问已被撤销'); } }), /已被撤销/);
});

test('206 ranges require exact start, end, total and Content-Length; a server ignoring Range is rejected', async t => {
  const { downloadSpatialAsset } = await ready;
  const cases = [
    { status: 200, range: null, length: CHUNK },
    { range: null, length: CHUNK },
    { range: `bytes 1-${CHUNK}/${big.length}`, length: CHUNK },
    { range: `bytes 0-${CHUNK - 1}/${big.length + 1}`, length: CHUNK },
    { range: `bytes 0-${CHUNK - 1}/${big.length}`, length: CHUNK - 1 },
    { range: `bytes 0-${CHUNK - 1}/${big.length}`, length: null }
  ];
  for (const item of cases) {
    await t.test(JSON.stringify(item), async t => {
      const fixture = await server(t, big, ({ res }) => {
        res.writeHead(item.status || 206, { ...(item.range ? { 'Content-Range': item.range } : {}), ...(item.length ? { 'Content-Length': item.length } : {}) });
        res.end(Buffer.alloc(1));
      });
      await assert.rejects(downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL }), /校验失败|无法读取/);
      assert.equal(fixture.requests.length, 1);
    });
  }
});

test('closing during a partial network stream aborts without requesting another range', async t => {
  const { downloadSpatialAsset } = await ready, controller = new AbortController();let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const fixture = await server(t, big, ({ res, start, end }) => {
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${big.length}`, 'Content-Length': end - start + 1 });
    res.write(big.subarray(0, 1024));res.on('close', closed);
  });
  await assert.rejects(downloadSpatialAsset(fixture.asset, { baseURL: fixture.baseURL, signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  await disconnected;assert.equal(fixture.requests.length, 1);
});

test('stream truncation, overflow and corrupt complete content never reach the SOG decoder', async t => {
  const { downloadSpatialAsset } = await ready;
  const asset = { format: 'sog', url: '/asset', bytes: small.length, digest: hash(small) };
  for (const payload of [small.subarray(0, small.length - 1), Buffer.concat([small, Buffer.from('!')]), Buffer.alloc(small.length)]) {
    let cancelled = false, offset = 0;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      pull(controller) { if (!offset++) controller.enqueue(payload);else if (payload.length <= small.length) controller.close(); },
      cancel() { cancelled = true; }
    }), { status: 200, headers: { 'Content-Length': String(small.length) } }));
    await assert.rejects(downloadSpatialAsset(asset, { baseURL: 'http://localhost/frame' }), /未完整下载|大小校验失败|完整性校验失败/);
    if (payload.length > small.length) assert.equal(cancelled, true);
    t.mock.restoreAll();
  }
});

test('invalid metadata and already-closed viewers make no network requests', async t => {
  const { downloadSpatialAsset } = await ready, controller = new AbortController();let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++;throw new Error('should not fetch'); });
  const asset = { format: 'sog', url: '/asset', bytes: small.length, digest: hash(small), chunkBytes: CHUNK };
  for (const change of [{ url: 'https://other.invalid/model' }, { bytes: 67108865 }, { chunkBytes: CHUNK + 1 }, { digest: '' }]) {
    await assert.rejects(downloadSpatialAsset({ ...asset, ...change }, { baseURL: 'http://localhost/frame' }));
  }
  controller.abort();await assert.rejects(downloadSpatialAsset(asset, { baseURL: 'http://localhost/frame', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests, 0);
});
