'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { assetURL, shareURL, createNetwork, parsePage } = require('../server/spatial-network');
const { SCENE, SHARE, ASSET, page } = require('./helpers/spatial-fixture');
const CDN = 'https://p1-app.insta360.com/model.sog?Signature=synthetic-test-only';
const publicDNS = async () => [{ address: '8.8.8.8', family: 4 }];
function fakeRequest(replies, inspect = () => {}) {
  let count = 0;
  return (url, options, receive) => {
    inspect(url, options);
    const req = new Writable({ write(_chunk, _encoding, done) { done(); } });
    req.setTimeout = () => req;
    req.on('finish', () => {
      const item = replies[Math.min(count++, replies.length - 1)];
      const response = Readable.from([item.body || Buffer.from('model')]);
      response.statusCode = item.status || 200; response.headers = item.headers || {};
      receive(response);
    });
    return req;
  };
}
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spatial-x6-safety-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('spatial-x6-safety-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'model.sog');
}

test('X6 exact CDN accepts only SOG/optional JSON, without making it a share host or generic proxy', () => {
  assert.equal(assetURL(CDN).hostname, 'p1-app.insta360.com');
  assert.equal(assetURL(CDN.replace('.sog', '.json'), 'json').hostname, 'p1-app.insta360.com');
  const parsed = parsePage(page(SCENE, { outputs: [
    { type: 'model', fileFormat: 'sog', url: CDN },
    { type: 'model', fileFormat: 'json', url: CDN.replace('.sog', '.json') }
  ] }), SCENE);
  assert.equal(new URL(parsed.url).hostname, 'p1-app.insta360.com');
  assert.equal(new URL(parsed.cameraURL).hostname, 'p1-app.insta360.com');
  for (const host of ['p1-app.insta360.com.evil.test', 'foo.p1-app.insta360.com', 'p2-app.insta360.com', 'p1-app.insta360.com.', 'insta360.com', '127.0.0.1', '169.254.169.254', '[::1]']) {
    assert.throws(() => assetURL(CDN.replace('p1-app.insta360.com', host)));
  }
  for (const url of [CDN.replace('https:', 'http:'), CDN.replace('p1-app.', 'user@p1-app.'), CDN.replace('.com/', '.com:444/'), CDN + '#x',
    CDN.replace('.sog', '.zip'), CDN.replace('.sog', '.mp4'), CDN.replace('.sog', '.ply'), CDN.replace('.sog', '.json')]) assert.throws(() => assetURL(url));
  assert.throws(() => shareURL(SHARE.replace('app.insta360.com', 'p1-app.insta360.com')));
});

test('X6 and original host redirects each re-resolve public DNS and pin the checked address', async t => {
  const filename = await temporary(t), resolutions = [], requests = [];
  const network = createNetwork({ lookup: async host => { resolutions.push(host); return publicDNS(); }, request: fakeRequest([
    { status: 302, headers: { location: CDN } }, { status: 302, headers: { location: ASSET } }, { body: Buffer.from('model') }
  ], (url, options) => {
    requests.push(url.hostname); assert.equal(options.agent, false); assert.equal(options.family, 4);
    assert.notEqual(options.rejectUnauthorized, false);
    options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
  }) });
  const result = await network.download(ASSET, filename, 10);
  assert.equal(result.bytes, 5); assert.deepEqual(requests, resolutions);
  assert.deepEqual(requests, ['insta360-app-hz.oss-cn-hangzhou.aliyuncs.com', 'p1-app.insta360.com', 'insta360-app-hz.oss-cn-hangzhou.aliyuncs.com']);
});

test('X6 CDN cannot redirect to private/metadata, unverified hosts, HTTP or a different resource type', async t => {
  const filename = await temporary(t);
  for (const location of ['https://127.0.0.1/model.sog', 'https://169.254.169.254/model.sog', 'https://10.0.0.1/model.sog',
    CDN.replace('p1-app', 'p2-app'), CDN.replace('.com/', '.com.evil.test/'), CDN.replace('https:', 'http:'), CDN.replace('.sog', '.zip')]) {
    let calls = 0;
    const network = createNetwork({ lookup: publicDNS, request: fakeRequest([{ status: 302, headers: { location } }], () => calls++) });
    await assert.rejects(network.download(CDN, filename, 10));
    assert.equal(calls, 1, 'reject redirect before a second connection');
  }
});

test('X6 resolves all DNS answers and rechecks after redirects, rejecting mixed private answers and rebinding', async t => {
  const filename = await temporary(t);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '169.254.0.23', '169.254.0.47', '100.64.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1']) {
    let calls = 0;
    const lookup = async () => [...await publicDNS(), { address, family: address.includes(':') ? 6 : 4 }];
    await assert.rejects(createNetwork({ lookup, request: () => { calls++; assert.fail('unsafe DNS must never connect'); } }).download(CDN, filename, 10), { code: 'unsafe_dns' });
    assert.equal(calls, 0);
  }
  let lookups = 0, calls = 0;
  const network = createNetwork({ lookup: async () => ++lookups === 1 ? publicDNS() : [{ address: '127.0.0.1', family: 4 }],
    request: fakeRequest([{ status: 302, headers: { location: CDN } }], () => calls++) });
  await assert.rejects(network.download(CDN, filename, 10), { code: 'unsafe_dns' });
  assert.equal(lookups, 2); assert.equal(calls, 1);
});

test('X6 CDN keeps actual/header byte limits, content encoding checks and aborts', async t => {
  const filename = await temporary(t);
  for (const reply of [{ headers: { 'content-length': '11' }, body: Buffer.from('x') }, { body: Buffer.alloc(11) },
    { headers: { 'content-encoding': 'gzip' }, body: Buffer.from('x') }]) {
    await assert.rejects(createNetwork({ lookup: publicDNS, request: fakeRequest([reply]) }).download(CDN, filename, 10));
    await fs.rm(filename, { force: true });
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(createNetwork({ lookup: publicDNS, request: () => assert.fail('aborted request must not connect') }).download(CDN, filename, 10, aborted.signal));
});
