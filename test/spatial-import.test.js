'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');
const { validateSog } = require('../server/spatial-sog');
const { SpatialError, shareURL, assetURL, publicAddress, resolvePublic, createNetwork, parsePage, parseCamera } = require('../server/spatial-network');
const { uploadCloud, readCloud } = require('../server/spatial-storage');
const { SCENE, SHARE, ASSET, webp, entries, zip, page } = require('./helpers/spatial-fixture');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function fakeRequest(replies, inspect = () => {}) {
  let index = 0;
  return (url, options, receive) => {
    inspect(url, options);
    const req = new Writable({ write(_chunk, _encoding, done) { done(); } });
    req.setTimeout = () => req;
    options.signal?.addEventListener('abort', () => req.destroy(options.signal.reason || new Error('aborted')), { once: true });
    req.on('finish', () => {
      const item = replies[Math.min(index++, replies.length - 1)];
      const response = Readable.from(item.chunks || [item.body || Buffer.alloc(0)]);
      response.statusCode = item.status || 200; response.headers = item.headers || {};
      receive(response);
    });
    return req;
  };
}
const publicDNS = async () => [{ address: '8.8.8.8', family: 4 }];
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spatial-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
async function fixture(t, options = {}) {
  const dir = await temporary(t), model = zip(); let downloads = 0;
  const network = { page: async url => page(shareURL(url).scene), download: async (_url, filename, _limit, signal) => {
    downloads++; await options.download?.(downloads, signal); signal.throwIfAborted(); await fs.writeFile(filename, model, { flag: 'wx' }); return { bytes: model.length, digest: hash(model) };
  } };
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'test', spatial: { ...options.spatial, network } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const owner = await app.api('create', { setupCode: 'test' }), invite = await app.api('invite', { role: 'frame' }, owner.token), frame = await app.api('join', { invite: invite.invite });
  const sent = await app.api('send', { id: 'space', link: SHARE + '?showTitle=0' }, owner.token);
  return { ...app, dir, network, model, base, owner, frame, id: sent.id, count: () => downloads };
}

test('strict share URL and model allowlists reject SSRF URL variants', async () => {
  assert.equal(shareURL(SHARE + '?showTitle=0').url, SHARE);
  for (const input of ['http://app.insta360.com/3dspace/detail/' + SCENE, SHARE.replace('app.', 'evil.'), SHARE.replace('app.insta360.com', 'app.insta360.com.evil.test'), SHARE.replace('app.insta360.com', 'user@app.insta360.com'), SHARE.replace('app.insta360.com', 'app.insta360.com:444'), SHARE + '#x', SHARE.replace(SCENE, 'GS3DC1'), SHARE.replace('/detail/', '/detail/%2e%2e/'), 'https://127.0.0.1/' + SCENE]) assert.throws(() => shareURL(input));
  for (const input of [ASSET.replace('https:', 'http:'), ASSET.replace('.aliyuncs.com', '.aliyuncs.com.evil.test'), ASSET.replace('/model.sog', '/model.zip'), ASSET.replace('insta360-app-hz.', 'other-bucket.')]) assert.throws(() => assetURL(input));
});
test('DNS rejects every private/reserved/mapped family and mixed public/private answers', async () => {
  for (const ip of ['127.0.0.1','0.0.0.0','10.1.1.1','100.64.0.1','169.254.169.254','172.16.1.1','192.168.0.1','198.18.0.1','224.1.1.1','::1','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::1']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
  await assert.rejects(resolvePublic('example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
  await assert.rejects(resolvePublic('example.com', async () => { throw new Error('DNS error with ' + ASSET); }), error => error.code === 'dns_failed' && !error.message.includes('Signature'));
});
test('every redirect repeats allowlist/DNS checks and transport is pinned to checked IP', async () => {
  let calls = 0, lookups = 0;
  const network = createNetwork({ lookup: async () => { lookups++; return publicDNS(); }, request: fakeRequest([{ status: 302, headers: { location: SHARE + '/' } }, { body: page() }], (_url, opts) => {
    calls++; assert.equal(opts.agent, false); opts.lookup('ignored', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
  }) });
  assert.match(await network.page(SHARE), /NEXT_DATA/); assert.equal(calls, 2); assert.equal(lookups, 2);
  for (const location of ['https://127.0.0.1/a', 'https://app.insta360.com.evil.test/a', 'http://app.insta360.com/a']) {
    const bad = createNetwork({ lookup: publicDNS, request: fakeRequest([{ status: 302, headers: { location } }]) });
    await assert.rejects(bad.page(SHARE));
  }
  const rebind = createNetwork({ lookup: async () => ++calls % 2 ? await publicDNS() : [{ address: '127.0.0.1', family: 4 }], request: fakeRequest([{ status: 302, headers: { location: SHARE } }]) });
  calls = 0; await assert.rejects(rebind.page(SHARE), /安全/);
});
test('network enforces content-length, chunked byte caps, content encoding, redirect limit and abort', async t => {
  const dir = await temporary(t);
  for (const reply of [{ headers: { 'content-length': '99' }, body: 'x' }, { chunks: [Buffer.alloc(5), Buffer.alloc(6)] }, { headers: { 'content-encoding': 'gzip' }, body: 'x' }, { status: 302, headers: { location: ASSET } }]) {
    const network = createNetwork({ lookup: publicDNS, request: fakeRequest([reply]) });
    await assert.rejects(network.download(ASSET, path.join(dir, crypto.randomUUID()), 10));
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(createNetwork({ lookup: publicDNS }).page(SHARE, aborted.signal));
});
test('provider page binds the exact scene, public status and SOG output, with safe optional camera', () => {
  assert.equal(parsePage(page(), SCENE).title, '测试空间');
  for (const html of ['invalid', page('GS3DC' + '1'.repeat(32)), page(SCENE, { isPrivate: 1 }), page(SCENE, { outputs: [] }), page(SCENE, { outputs: [{ type: 'model', fileFormat: 'sog', url: 'https://evil.test/a.sog' }] })]) assert.throws(() => parsePage(html, SCENE));
  const camera = [{ img_name: 'frame_000000_cam1_center', position: [1,2,3], rotation: [[1,0,0],[0,1,0],[0,0,1]], width: 960, height: 960, fx: 480, fy: 480 }];
  assert.deepEqual(parseCamera(JSON.stringify(camera)), { position: [1,2,3], forward: [0,0,1], up: [-0,-1,-0], fov: 75 });
  camera[0].rotation[0][0] = 100; assert.equal(parseCamera(JSON.stringify(camera)), undefined);
  assert.equal(parseCamera('{}'), undefined);
});

test('unsupported host, private share and missing model remain distinct without exposing signed resources', () => {
  const cases = [
    [{ isPrivate: 1 }, 'share_private'],
    [{ outputs: [{ type: 'video', fileFormat: 'mp4', url: ASSET }, { type: 'model', fileFormat: 'zip', url: ASSET }] }, 'model_missing'],
    [{ outputs: [{ type: 'model', fileFormat: 'sog', url: 'https://unverified.invalid/model.sog?Signature=secret' }] }, 'unsupported_asset_host']
  ];
  for (const [overrides, code] of cases) assert.throws(() => parsePage(page(SCENE, overrides), SCENE), error => error.code === code && !error.message.includes('Signature'));
});
test('SOG accepts bounded v2 stored/deflated archives including data descriptors', async t => {
  const dir = await temporary(t);
  for (const options of [{}, { descriptor: true }, { method: 8 }]) {
    const filename = path.join(dir, crypto.randomUUID()); await fs.writeFile(filename, zip(entries(), options));
    assert.equal((await validateSog(filename)).count, 1);
  }
});
test('SOG rejects malformed ZIP, traversal, duplicate names, CRC errors and metadata/texture bombs', async t => {
  const dir = await temporary(t), corrupted = zip(); corrupted[45] ^= 1;
  const invalid = [Buffer.from('not a zip'), corrupted, zip(entries().map(([n,b],i) => [i ? n : '../meta.json', b])), zip([...entries(), entries()[0]]), zip(entries({ version: 3 })), zip(entries({ count: 2000001 })), zip(entries({ means: { mins: [0,0,0], maxs: [1,1,1], files: ['https://evil.test/a.webp','means_u.webp'] } })), zip(entries({}, webp(16000,16000))), zip(entries(), { method: 9 }), zip(entries({ scales: { codebook: Array(256).fill(1e100), files: ['scales.webp'] } }))];
  for (const value of invalid) { const filename = path.join(dir, crypto.randomUUID()); await fs.writeFile(filename, value); await assert.rejects(validateSog(filename)); }
  const filename = path.join(dir, 'limit.sog'); await fs.writeFile(filename, zip());
  await assert.rejects(validateSog(filename, { limits: { file: 100000, entry: 100, expanded: 100 } }));
});
test('HTTP import stays request-bound; state polls only metadata; duplicate workers and scenes download once', async t => {
  const started = gate(), finish = gate();
  const f = await fixture(t, { download: async () => { started.release(); await finish.promise; } });
  let settled = false; const pending = f.api('spatialImport', { id: f.id }, f.owner.token).then(x => { settled = true; return x; });
  await started.promise; assert.equal(settled, false);
  const second = await createApp({ store: f.store, setupCode: 'test', spatial: { network: f.network } });
  assert.equal((await second.api('spatialImport', { id: f.id }, f.owner.token)).spatial.status, 'importing');
  const item = (await f.api('state', {}, f.frame.token)).messages[0]; assert.equal(item.spatial.stage, 'downloading');
  assert.equal(item.spatial.sourceURL, SHARE); assert.equal(f.count(), 1); assert.equal(JSON.stringify(item).includes('Signature'), false);
  finish.release(); assert.equal((await pending).spatial.status, 'ready');
  const duplicate = await f.api('send', { id: 'same-source', link: SHARE }, f.owner.token);
  assert.equal((await f.api('spatialImport', { id: duplicate.id }, f.owner.token)).spatial.status, 'ready'); assert.equal(f.count(), 1);
  const records = await fs.readFile(path.join(f.dir, 'records.json'), 'utf8'); assert.equal(records.includes('Signature'), false);
  assert.equal((await fs.readdir(path.join(f.dir, 'media'))).length, 1);
});
test('family-only imports, room isolation, private reads, expired/tampered/revoked grants', async t => {
  let time = Date.now(); const f = await fixture(t, { spatial: { clock: () => time } });
  const other = await f.api('create', { setupCode: 'test' });
  await assert.rejects(f.api('spatialImport', { id: f.id }, f.frame.token), { status: 403 });
  for (const action of ['spatialImport','spatialAsset']) await assert.rejects(f.api(action, { id: f.id }, other.token), { status: 404 });
  await assert.rejects(f.api('spatialImport', { id: { $ne: null } }, f.owner.token), { status: 404 });
  await f.api('spatialImport', { id: f.id }, f.owner.token);
  const asset = await f.api('spatialAsset', { id: f.id }, f.frame.token);
  assert.equal(asset.format, 'sog'); assert.equal(asset.bytes, f.model.length); assert.equal(asset.digest, hash(f.model));
  const response = await fetch(f.base + asset.url); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.model); assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await fetch(f.base + asset.url.slice(0, -1) + (asset.url.endsWith('0') ? '1' : '0'))).status, 404);
  time += 121000; assert.equal((await fetch(f.base + asset.url)).status, 404);
  const renewed = await f.api('spatialAsset', { id: f.id }, f.frame.token); assert.equal((await fetch(f.base + renewed.url)).status, 200);
  const member = (await f.api('state', {}, f.owner.token)).members.find(x => x.role === 'frame'); await f.api('revoke', { id: member.id }, f.owner.token);
  assert.equal((await fetch(f.base + renewed.url)).status, 404);
});
test('failed imports are sanitized and retryable; original link and unrelated text remain intact', async t => {
  const f = await fixture(t, { download: async calls => { if (calls === 1) throw new Error('failed at ' + ASSET); } });
  const failed = await f.api('spatialImport', { id: f.id }, f.owner.token); assert.equal(failed.spatial.status, 'failed'); assert.equal(failed.spatial.error.includes('Signature'), false);
  assert.equal(failed.spatial.failureStage, 'downloading'); assert.equal(failed.spatial.errorCode, 'import_failed');
  assert.equal((await f.store.get(f.id)).link, SHARE + '?showTitle=0');
  await f.api('edit', { id: f.id, text: '家人补充', title: '空间' }, f.owner.token);
  assert.equal((await f.api('spatialImport', { id: f.id }, f.owner.token)).spatial.status, 'ready'); assert.equal((await f.store.get(f.id)).editedText, '家人补充');
});
test('durable expired lease is visible as failed and recovered after local store reload', async t => {
  const f = await fixture(t); const roomKey = 'sp_' + f.owner.room;
  await f.store.put({ _id: roomKey, kind: 'spatial', room: f.owner.room, secret: 'secret', entries: { [SCENE]: { sourceURL: SHARE, status: 'importing', stage: 'downloading', progress: 15, lease: 'dead-worker', leaseUntil: 1, updatedAt: 1 } } });
  const restart = await createApp({ store: new LocalStore(f.dir), setupCode: 'test', spatial: { network: f.network } });
  const state = await restart.api('state', {}, f.owner.token); assert.equal(state.messages[0].spatial.status, 'failed'); assert.equal(state.messages[0].spatial.stage, 'expired');
  assert.equal((await restart.api('spatialImport', { id: f.id }, f.owner.token)).spatial.status, 'ready'); assert.equal(f.count(), 1);
});
test('expired worker cannot overwrite successor or delete its asset', async t => {
  const started = gate(), finish = gate();
  const f = await fixture(t, { download: async calls => { if (calls === 1) { started.release(); await finish.promise; } } });
  const slow = f.api('spatialImport', { id: f.id }, f.owner.token); await started.promise;
  await f.store.mutate('sp_' + f.owner.room, record => { record.entries[SCENE].leaseUntil = 1; return record; });
  const next = await createApp({ store: f.store, setupCode: 'test', spatial: { network: f.network } });
  assert.equal((await next.api('spatialImport', { id: f.id }, f.owner.token)).spatial.status, 'ready');
  const winningFile = (await f.store.get('sp_' + f.owner.room)).entries[SCENE].file;
  finish.release(); await slow;
  const entry = (await f.store.get('sp_' + f.owner.room)).entries[SCENE]; assert.equal(entry.status, 'ready'); assert.equal(entry.file, winningFile);
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'media')), [winningFile]);
});
test('atomic family quota includes reservations during concurrent imports', async t => {
  const started = gate(), finish = gate(); const f = await fixture(t, { spatial: { maxModels: 1 }, download: async () => { started.release(); await finish.promise; } });
  const pending = f.api('spatialImport', { id: f.id }, f.owner.token); await started.promise;
  const other = await f.api('send', { id: 'second-scene', link: SHARE.replace(SCENE, 'GS3DC' + 'a'.repeat(32)) }, f.owner.token);
  await assert.rejects(f.api('spatialImport', { id: other.id }, f.owner.token), { status: 409 });
  finish.release(); await pending; assert.equal(f.count(), 1);
  await assert.rejects(f.api('spatialImport', { id: other.id }, f.owner.token), { status: 409 });
});
test('deadline aborts request-bound work and failure clears reservation for retry', { timeout: 10000 }, async t => {
  let stall = true;
  const f = await fixture(t, { spatial: { budgetMs: 30 }, download: async (_calls, signal) => { if (stall) await new Promise((_, reject) => {
    // File I/O before download may consume the deadline; abort is not replayed
    // for listeners attached after it has already fired.
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }); } });
  const result = await f.api('spatialImport', { id: f.id }, f.owner.token); assert.equal(result.spatial.status, 'failed'); assert.match(result.spatial.error, /超时/);
  // Under parallel browser load the first attempt can expire before download.
  // Release the fault by attempt, not by the number of downloads reached.
  stall = false;
  const next = await createApp({ store: f.store, setupCode: 'test', spatial: { network: f.network } });
  assert.equal((await next.api('spatialImport', { id: f.id }, f.owner.token)).spatial.status, 'ready');
});
test('soft removal preserves completed model, invalidates access, and permits family reuse', async t => {
  const f = await fixture(t); await f.api('spatialImport', { id: f.id }, f.owner.token);
  const asset = await f.api('spatialAsset', { id: f.id }, f.owner.token); await f.api('remove', { id: f.id }, f.owner.token);
  assert.equal((await fetch(f.base + asset.url)).status, 404); assert.equal((await fs.readdir(path.join(f.dir, 'media'))).length, 1);
  const replacement = await f.api('send', { id: 'replacement', link: SHARE }, f.owner.token);
  assert.equal((await f.api('spatialImport', { id: replacement.id }, f.owner.token)).spatial.status, 'ready'); assert.equal(f.count(), 1);
});
test('removing a message during download fences its worker and leaves no private orphan', async t => {
  const started = gate(), finish = gate(); const f = await fixture(t, { download: async () => { started.release(); await finish.promise; } });
  const pending = f.api('spatialImport', { id: f.id }, f.owner.token); await started.promise;
  await f.api('remove', { id: f.id }, f.owner.token); finish.release(); await pending;
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'media')), []); assert.equal((await f.store.get('sp_' + f.owner.room)).entries[SCENE].status, 'failed');
});
test('removal CAS conflict with ready commit cannot delete the completed model', async t => {
  const f = await fixture(t); await f.api('spatialImport', { id: f.id }, f.owner.token);
  const roomKey = 'sp_' + f.owner.room, ready = (await f.store.get(roomKey)).entries[SCENE], mutate = f.store.mutate.bind(f.store);
  await mutate(roomKey, current => { current.entries[SCENE] = { ...ready, status: 'importing', stage: 'storing', file: '', pendingFile: ready.file, leaseUntil: Date.now() + 10000 }; return current; });
  let conflict = true;
  f.store.mutate = async (id, change, options) => {
    if (id === roomKey && conflict) {
      conflict = false;
      const proposed = change(await f.store.get(id)); assert.equal(proposed.entries[SCENE].stage, 'removed');
      // Another instance wins the CAS by committing ready before removal retries.
      await mutate(id, current => { current.entries[SCENE] = ready; return current; });
      assert.equal(change(await f.store.get(id)), null); return null;
    }
    return mutate(id, change, options);
  };
  await f.api('remove', { id: f.id }, f.owner.token);
  assert.equal(conflict, false); assert.equal((await f.store.get(roomKey)).entries[SCENE].status, 'ready');
  assert.deepEqual(await fs.readFile(path.join(f.dir, 'media', ready.file)), f.model);
});
test('ZIP comments rejected to match the selected viewer decoder', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'comment.sog'), model = zip();
  model.writeUInt16LE(4, model.length - 2); await fs.writeFile(filename, Buffer.concat([model, Buffer.from('note')]));
  await assert.rejects(validateSog(filename));
});
test('old removal cleanup cannot clear a newer failed removal pending file', async t => {
  const f = await fixture(t); await f.api('spatialImport', { id: f.id }, f.owner.token);
  const roomKey = 'sp_' + f.owner.room, entry = (await f.store.get(roomKey)).entries[SCENE], file1 = entry.file, file2 = 'new-worker.sog';
  await f.store.mutate(roomKey, current => { current.entries[SCENE] = { ...entry, status: 'importing', stage: 'storing', pendingFile: file1, file: '' }; return current; });
  await fs.writeFile(path.join(f.dir, 'media', file2), f.model);
  const remove = f.store.deleteFile.bind(f.store);
  f.store.deleteFile = async file => {
    assert.equal(file, file1); await remove(file);
    // While R1 awaited file I/O, another import and R2 cancellation occurred;
    // R2's physical delete failed and therefore its pointer must remain durable.
    await f.store.mutate(roomKey, current => { current.entries[SCENE] = { ...current.entries[SCENE], cleanup: 'new-removal', pendingFile: file2 }; return current; });
  };
  await f.api('remove', { id: f.id }, f.owner.token);
  assert.equal((await f.store.get(roomKey)).entries[SCENE].pendingFile, file2);
  assert.deepEqual(await fs.readFile(path.join(f.dir, 'media', file2)), f.model);
});
test('private upload failure is cleaned up and never reports ready', async t => {
  const f = await fixture(t), original = f.store.importSpatial.bind(f.store);
  f.store.importSpatial = async (...args) => { await original(...args); throw new Error('storage failed ' + ASSET); };
  const result = await f.api('spatialImport', { id: f.id }, f.owner.token); assert.equal(result.spatial.status, 'failed');
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'media')), []); assert.equal(JSON.stringify(await f.store.get('sp_' + f.owner.room)).includes('Signature'), false);
});
test('CloudBase upload contract maps authenticated metadata to bounded stream PUT', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'model.sog'); await fs.writeFile(filename, zip());
  let allocated, requested = 0;
  const app = { getUploadMetadata: async ({ cloudPath }, options) => {
    assert.equal(cloudPath, 'memory-demo/spatial/test.sog'); assert.equal(options.retryOptions.retries, 0);
    return { data: { url: 'https://storage.example.test/model', token: 'test-token', authorization: 'test-auth', fileId: 'cloud://private-file', cosFileId: 'test-cos-file' } };
  } };
  const file = await uploadCloud(app, 'test.sog', filename, { lookup: publicDNS, allocated: async id => { allocated = id; }, request: fakeRequest([{}], (_url, options) => {
    requested++; assert.equal(options.method, 'PUT'); assert.equal(options.headers.Signature, 'test-auth'); assert.equal(options.headers.authorization, 'test-auth'); assert.equal(options.headers['x-cos-security-token'], 'test-token'); assert.equal(options.headers['x-cos-meta-fileid'], 'test-cos-file'); assert.equal(options.headers.key, 'memory-demo%2Fspatial%2Ftest.sog'); assert.equal(options.headers['Content-Length'], zip().length);
  }) });
  assert.equal(file, 'cloud://private-file'); assert.equal(allocated, file); assert.equal(requested, 1);
});
test('cloud PUT refuses unsafe metadata, non-2xx/XML errors and abort destroys the request', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'model.sog'); await fs.writeFile(filename, zip());
  const data = { url: 'https://storage.example.test/model', token: 't', authorization: 'a', fileId: 'f', cosFileId: 'c' }, base = { lookup: publicDNS, allocated: async () => {} };
  for (const reply of [{ status: 403 }, { status: 200, body: '<Error>denied</Error>' }, { status: 302, headers: { location: 'https://evil.test/' } }]) await assert.rejects(uploadCloud({ getUploadMetadata: async () => ({ data }) }, 'test.sog', filename, { ...base, request: fakeRequest([reply]) }));
  await assert.rejects(uploadCloud({ getUploadMetadata: async () => ({ data: { ...data, url: 'http://storage.example.test/model' } }) }, 'test.sog', filename, base), /HTTPS/);
  const controller = new AbortController(); let destroyed = false;
  await assert.rejects(uploadCloud({ getUploadMetadata: async () => ({ data }) }, 'test.sog', filename, { ...base, signal: controller.signal, request: (_url, options) => {
    const req = new Writable({ write(_chunk, _encoding, _done) { setImmediate(() => controller.abort(new Error('abort'))); }, destroy(error, done) { destroyed = true; done(error); } }); req.setTimeout = () => req;
    options.signal.addEventListener('abort', () => req.destroy(options.signal.reason), { once: true }); return req;
  } })); assert.equal(destroyed, true);
});
test('cloud private read is streamed with byte limits and refuses redirects/HTTP downgrade', async () => {
  const app = { getTempFileURL: async () => ({ fileList: [{ tempFileURL: 'https://storage.example.test/private?signature=secret', code: 'SUCCESS' }] }) };
  const stream = await readCloud(app, 'server-owned-id', 3, { lookup: publicDNS, request: fakeRequest([{ body: 'abc' }]) });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'abc');
  await assert.rejects(readCloud(app, 'server-owned-id', 3, { lookup: publicDNS, request: fakeRequest([{ status: 302 }]) }));
  const oversized = await readCloud(app, 'server-owned-id', 2, { lookup: publicDNS, request: fakeRequest([{ body: 'abc' }]) });
  await assert.rejects(async () => { for await (const _chunk of oversized) { /* drain */ } });
});
test('cloud DNS rejection diagnostics contain only host and categories, without weakening rejection', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'model.sog'); await fs.writeFile(filename, zip());
  const diagnostics = [], url = 'https://bucket.cos.ap-shanghai.myqcloud.com/private-path?signature=must-not-log';
  const app = {
    getUploadMetadata: async () => ({ data: { url, token: 'must-not-log-token', authorization: 'must-not-log-auth', fileId: 'private-file-id', cosFileId: 'private-cos-id' } }),
    getTempFileURL: async () => ({ fileList: [{ tempFileURL: url, code: 'SUCCESS' }] })
  };
  const options = { lookup: async () => [{ address: '10.22.33.44', family: 4 }, { address: '10.22.33.45', family: 4 }, { address: '100.64.22.33', family: 4 }],
    diagnostic: entry => diagnostics.push(entry), allocated: async () => assert.fail('must reject before allocation'), request: () => assert.fail('must not connect') };
  await assert.rejects(uploadCloud(app, 'test.sog', filename, options), /安全检查/);
  await assert.rejects(readCloud(app, 'private-file-id', 1, options), /安全检查/);
  assert.deepEqual(diagnostics.map(entry => entry.operation), ['upload', 'read']);
  assert.deepEqual(diagnostics[0], { event: 'spatial-storage-dns-rejected', operation: 'upload', hostname: 'bucket.cos.ap-shanghai.myqcloud.com', answers: [
    { family: '4', category: 'private-10', count: 2 }, { family: '4', category: 'shared-100', count: 1 }
  ] });
  const serialized = JSON.stringify(diagnostics);
  for (const secret of ['10.22.33', '100.64.22.33', 'private-path', 'signature', 'private-file-id', 'private-cos-id', 'must-not-log']) assert.equal(serialized.includes(secret), false);
});
test('storage DNS diagnostic stays private and is discarded on the next import attempt', async t => {
  const f = await fixture(t), original = f.store.importSpatial.bind(f.store);
  const diagnostic = { event: 'spatial-storage-dns-rejected', operation: 'upload', hostname: 'bucket.cos.ap-shanghai.myqcloud.com', answers: [{ family: '4', category: 'private-10', count: 1 }] };
  f.store.importSpatial = async () => {
    const error = new SpatialError('模型资源地址未通过安全检查'); error.storageDiagnostic = diagnostic; throw error;
  };
  const failed = await f.api('spatialImport', { id: f.id }, f.owner.token);
  assert.equal(failed.spatial.status, 'failed'); assert.equal('storageDiagnostic' in failed.spatial, false);
  assert.deepEqual((await f.store.get('sp_' + f.owner.room)).entries[SCENE].storageDiagnostic, diagnostic);
  assert.equal(JSON.stringify(await f.api('state', {}, f.owner.token)).includes('storageDiagnostic'), false);
  f.store.importSpatial = original;
  assert.equal((await f.api('spatialImport', { id: f.id }, f.owner.token)).spatial.status, 'ready');
  assert.equal('storageDiagnostic' in (await f.store.get('sp_' + f.owner.room)).entries[SCENE], false);
});

test('authenticated same-environment COS uses its pinned internal route for upload and signed read', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'model.sog'); await fs.writeFile(filename, zip());
  const environment = 'test-env', bucket = 'test-env-1234567890', object = 'memory-demo/spatial/test.sog';
  const url = `https://${bucket}.cos.ap-shanghai.myqcloud.com/${object}`, fileId = `cloud://${environment}.${bucket}/${object}`;
  let uploaded = false, allocated = false;
  const app = {
    getUploadMetadata: async () => ({ data: { url, fileId, token: 't', authorization: 'a', cosFileId: 'c' } }),
    getTempFileURL: async ({ fileList }) => {
      assert.deepEqual(fileList, [{ fileID: fileId, maxAge: 120, urlType: 'COS_URL' }]);
      return { fileList: [{ tempFileURL: url + '?signature=private', code: 'SUCCESS' }] };
    }
  };
  const options = { environment, lookup: async () => [{ address: '169.254.0.47', family: 4 }],
    diagnostic: () => assert.fail('valid storage routing should not log'), allocated: async value => { allocated = value === fileId; } };
  await uploadCloud(app, 'test.sog', filename, { ...options, request: fakeRequest([{}], (parsed, request) => {
    assert.equal(allocated, true); assert.equal(parsed.hostname, bucket + '.cos.ap-shanghai.myqcloud.com');
    assert.equal(request.agent, false); assert.notEqual(request.rejectUnauthorized, false); assert.equal(request.family, 4);
    request.lookup(parsed.hostname, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '169.254.0.47'); assert.equal(family, 4); });
    uploaded = true;
  }) });
  assert.equal(uploaded, true);
  const stream = await readCloud(app, fileId, 3, { ...options, request: fakeRequest([{ body: 'abc' }], (_parsed, request) => {
    assert.equal(request.method, 'GET'); assert.equal(request.agent, false);
    request.lookup('not-looked-up-again', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '169.254.0.47', family: 4 }]); });
  }) });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'abc');
});
test('COS internal exception cannot be used for another environment, bucket, host, object or unsafe address', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'model.sog'); await fs.writeFile(filename, zip());
  const environment = 'test-env', fileId = 'cloud://test-env.test-env-1234567890/memory-demo/spatial/test.sog';
  const url = 'https://test-env-1234567890.cos.ap-shanghai.myqcloud.com/memory-demo/spatial/test.sog';
  const base = { url, fileId, token: 't', authorization: 'a', cosFileId: 'c' };
  const options = { environment, diagnostic: () => {}, lookup: async () => [{ address: '169.254.0.47', family: 4 }],
    allocated: async () => assert.fail('must not allocate'), request: () => assert.fail('must not connect') };
  for (const data of [
    { ...base, fileId: fileId.replace('cloud://test-env.', 'cloud://other-env.') },
    { ...base, fileId: fileId.replace('.test-env-1234567890/', '.other-bucket-1234567890/') },
    { ...base, fileId: fileId.replace('/test.sog', '/other.sog') },
    { ...base, fileId: fileId.replace('/memory-demo/spatial/', '/other-path/') },
    { ...base, url: url.replace('.myqcloud.com/', '.myqcloud.com.evil.test/') },
    { ...base, url: url.replace('test-env-1234567890.cos', 'other-bucket-1234567890.cos') },
    { ...base, url: url.replace('/test.sog', '/other.sog') },
    { ...base, url: url.replace('/memory-demo/spatial/test.sog', '/latest/meta-data') },
    { ...base, url: 'https://169.254.0.47/model' },
    { ...base, url: 'https://storage.example.test/model' }
  ]) await assert.rejects(uploadCloud({ getUploadMetadata: async () => ({ data }) }, 'test.sog', filename, options), /安全检查/);
  for (const address of ['10.22.33.44', '169.254.0.23', '169.254.0.0', '169.254.0.255', '169.254.1.47', '127.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.1.1', '198.18.1.1', '0.0.0.0', '224.0.0.1', '::ffff:169.254.0.47', 'fc00::1', '::1']) {
    await assert.rejects(uploadCloud({ getUploadMetadata: async () => ({ data: base }) }, 'test.sog', filename,
      { ...options, lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }), /安全检查/);
  }
  await assert.rejects(uploadCloud({ getUploadMetadata: async () => ({ data: base }) }, 'test.sog', filename,
    { ...options, lookup: async () => [{ address: '169.254.0.47', family: 4 }, { address: '169.254.169.254', family: 4 }] }), /安全检查/);
  await assert.rejects(readCloud({ getTempFileURL: async () => ({ fileList: [{ tempFileURL: url.replace('/test.sog', '/other.sog'), code: 'SUCCESS' }] }) }, fileId, 3, options), /安全检查/);
  // The user-supplied provider path still rejects the exact same private address.
  await assert.rejects(resolvePublic('insta360-app-hz.oss-cn-hangzhou.aliyuncs.com', options.lookup), /安全检查/);
});
