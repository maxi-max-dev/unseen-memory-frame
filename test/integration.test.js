'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');
const { LocalStore, CloudStore } = require('../server/store');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
function wav() {
  const b = Buffer.alloc(3244); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(3200, 40); return b;
}
async function fixture(t, ai) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-test-'));
  const app = await createApp({ dataDir: dir, setupCode: 'test-code', ai });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  async function call(action, data = {}, token, expected = 200) {
    const r = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token || ''}` }, body: JSON.stringify({ action, data }) });
    const result = await r.json(); assert.equal(r.status, expected, JSON.stringify(result)); return result;
  }
  const owner = await call('create', { setupCode: 'test-code' });
  const inv = await call('invite', { role: 'frame' }, owner.token);
  const frame = await call('join', { invite: inv.invite });
  return { ...app, dir, base, call, owner, frame, inv };
}
test('HTTP: two sessions transfer files, retry sends/uploads, restart persistence and receipts', async t => {
  const f = await fixture(t), { call, owner, frame } = f;
  const uploads = await Promise.all(Array.from({ length: 4 }, () => call('upload', { base64: png.toString('base64') }, owner.token)));
  assert.equal(new Set(uploads.map(x => x.id)).size, 1);
  assert.equal((await fs.readdir(path.join(f.dir, 'media'))).length, 1);
  const sends = await Promise.all(Array.from({ length: 4 }, () => call('send', { id: 'stable-send', image: uploads[0].id }, owner.token)));
  assert.equal(new Set(sends.map(x => x.id)).size, 1);
  let state = await call('state', {}, frame.token); assert.equal(state.messages.length, 1);
  assert.deepEqual(Buffer.from(await (await fetch(f.base + state.messages[0].imageURL)).arrayBuffer()), png);
  const audio = await call('upload', { base64: wav().toString('base64') }, frame.token);
  const reply = await call('send', { id: 'reply', audio: audio.id, parent: sends[0].id }, frame.token);
  state = await call('state', {}, owner.token); assert.equal(state.messages[1]._id, reply.id);
  assert.deepEqual(Buffer.from(await (await fetch(f.base + state.messages[1].audioURL)).arrayBuffer()), wav());
  await Promise.all([call('receipt', { id: sends[0].id, played: true }, frame.token), call('receipt', { id: sends[0].id }, frame.token)]);
  assert.ok((await call('state', {}, owner.token)).receipts[0].playedAt);
  const restarted = await createApp({ dataDir: f.dir, setupCode: 'test-code' });
  assert.equal((await restarted.api('state', {}, owner.token)).messages.length, 2);
});
test('HTTP: room isolation, frame restrictions, injection, expired and revoked pairing', async t => {
  const { call, store, owner, frame, inv } = await fixture(t);
  const other = await call('create', { setupCode: 'test-code' });
  const file = await call('upload', { base64: png.toString('base64') }, owner.token);
  const m = await call('send', { id: 'photo', image: file.id }, owner.token);
  await call('send', { id: 'theft', image: file.id }, other.token, 404);
  for (const action of ['edit', 'remove', 'process', 'receipt']) await call(action, { id: m.id }, other.token, action === 'receipt' ? 403 : 404);
  for (const action of ['edit', 'remove', 'invite', 'person', 'revoke']) await call(action, { id: m.id, name: 'x' }, frame.token, 403);
  await call('send', { id: 'bad', text: 'frame photo' }, frame.token, 400);
  await call('process', { id: m.id }, frame.token, 404);
  await call('edit', { id: { $ne: null } }, owner.token, 404);
  await call('process', { id: { $ne: null } }, owner.token, 404);
  await call('revoke', { id: inv.id }, owner.token);
  await call('join', { invite: inv.invite }, undefined, 400);
  const expired = await call('invite', {}, owner.token);
  await store.mutate(expired.id, x => ({ ...x, expires: 1 }));
  await call('join', { invite: expired.invite }, undefined, 400);
  const member = (await call('state', {}, owner.token)).members.find(x => x.role === 'frame');
  await call('revoke', { id: member.id }, owner.token);
  await call('state', {}, frame.token, 401);
});
test('invalid uploads rejected and failed metadata write removes orphan', async t => {
  const { call, store, dir, owner } = await fixture(t);
  for (const buffer of [Buffer.from('garbage'), png.subarray(0, 8), Buffer.from([255,216,255]), wav().subarray(0, 44)]) {
    await call('upload', { base64: buffer.toString('base64') }, owner.token, 400);
  }
  await call('upload', { base64: '%%%%' }, owner.token, 400);
  const put = store.put.bind(store); store.put = async (doc, create) => { if (doc.kind === 'file') throw new Error('disk failure'); return put(doc, create); };
  await call('upload', { base64: png.toString('base64') }, owner.token, 503);
  assert.deepEqual(await fs.readdir(path.join(dir, 'media')), []);
});
test('AI failure preserves original audio', async t => {
  const { call, owner, base } = await fixture(t, { transcribe: async () => { throw new Error('语音服务失败'); } });
  const audio = await call('upload', { base64: wav().toString('base64') }, owner.token);
  const m = await call('send', { id: 'audio', audio: audio.id }, owner.token);
  await call('process', { id: m.id }, owner.token);
  const item = (await call('state', {}, owner.token)).messages[0];
  assert.equal(item.aiStatus, 'failed'); assert.match(item.aiError, /语音服务失败/);
  assert.deepEqual(Buffer.from(await (await fetch(base + item.audioURL)).arrayBuffer()), wav());
});
test('persistent lease prevents duplicate AI across apps; concurrent edits survive both AI writes', async t => {
  let releaseAsr, releaseSummary, calls = 0, summaryStarted;
  const summaryReady = new Promise(r => { summaryStarted = r; });
  const ai = { transcribe: () => { calls++; return new Promise(r => { releaseAsr = r; }); }, summarize: () => { summaryStarted(); return new Promise(r => { releaseSummary = r; }); } };
  const { call, owner, store } = await fixture(t, ai);
  const audio = await call('upload', { base64: wav().toString('base64') }, owner.token);
  const m = await call('send', { id: 'race', audio: audio.id }, owner.token);
  const pending = call('process', { id: m.id }, owner.token);
  while (!releaseAsr) await new Promise(r => setTimeout(r, 5));
  const second = await createApp({ store, setupCode: 'test-code', ai });
  await second.api('process', { id: m.id }, owner.token);
  assert.equal(calls, 1);
  await call('edit', { id: m.id, text: '人工文字', title: '人工标题', summary: '人工整理' }, owner.token);
  releaseAsr('真实转写'); await summaryReady;
  await call('edit', { id: m.id, text: '最终修订', title: '最终标题', summary: '最终整理' }, owner.token);
  releaseSummary({ title: 'AI标题' }); await pending;
  const item = (await call('state', {}, owner.token)).messages[0];
  assert.equal(item.editedText, '最终修订'); assert.equal(item.card.summary, '最终整理'); assert.equal(item.transcription, '真实转写'); assert.equal(item.aiStatus, 'done');
  await second.api('process', { id: m.id }, owner.token); assert.equal(calls, 1);
});
test('CloudStore CAS contract retries conflicts and rejects object IDs before querying', async () => {
  const cloud = Object.create(CloudStore.prototype);
  let record = { _id: 'm', kind: 'message', editedText: 'first' }, conflict = true, reads = 0;
  cloud.db = { command: { exists: value => ({ exists: value }) } };
  cloud.collection = { where(query) { return {
    limit() { return this; }, async get() { reads++; return { data: record ? [structuredClone(record)] : [] }; },
    async update(data) {
      if (conflict) { conflict = false; record = { ...record, editedText: 'human', _rev: 1 }; return { updated: 0 }; }
      assert.equal(query._rev, record._rev);
      record = { ...record, ...data }; return { updated: 1 };
    }
  }; } };
  await cloud.mutate('m', current => ({ ...current, aiStatus: 'done' }));
  assert.equal(record.editedText, 'human'); assert.equal(record._rev, 2); assert.equal(reads, 2);
  assert.equal(await cloud.get({ $ne: null }), null); assert.equal(reads, 2);
});
test('lease survives store reload and expires for retry', async t => {
  const { call, owner, store, dir } = await fixture(t);
  const m = await call('send', { id: 'lease-restart', text: '原话' }, owner.token);
  await store.mutate(m.id, x => ({ ...x, aiStatus: 'processing', aiLease: 'crashed', aiLeaseUntil: Date.now() + 10000 }));
  let calls = 0;
  const restart = await createApp({ dataDir: dir, setupCode: 'test-code', ai: { summarize: async () => { calls++; return { title: '记忆' }; } } });
  await restart.api('process', { id: m.id }, owner.token); assert.equal(calls, 0);
  await restart.store.mutate(m.id, x => ({ ...x, aiLeaseUntil: 1 }));
  await restart.api('process', { id: m.id }, owner.token); assert.equal(calls, 1);
  assert.equal((await restart.store.get(m.id)).aiStatus, 'done');
});
test('expired lease fences a slow worker from overwriting its successor', async t => {
  let finish;
  const { call, store, owner } = await fixture(t, { summarize: () => new Promise(r => { finish = r; }) });
  const m = await call('send', { id: 'fencing', text: '记忆' }, owner.token);
  const slow = call('process', { id: m.id }, owner.token);
  while (!finish) await new Promise(r => setTimeout(r, 5));
  await store.mutate(m.id, x => ({ ...x, aiLeaseUntil: 1 }));
  const second = await createApp({ store, setupCode: 'test-code', ai: { summarize: async () => ({ title: 'new worker' }) } });
  await second.api('process', { id: m.id }, owner.token);
  finish({ title: 'old worker' }); await slow;
  assert.equal((await store.get(m.id)).card.title, 'new worker');
});
test('manual original skips ASR, empty summary permits AI, edited original can be organized again', async t => {
  let asrCalls = 0; const inputs = [];
  const { call, owner } = await fixture(t, { transcribe: async () => { asrCalls++; throw new Error('语音失败'); }, summarize: async input => { inputs.push(input); return { summary: input, confirmed: false }; } });
  const audio = await call('upload', { base64: wav().toString('base64') }, owner.token);
  const m = await call('send', { id: 'manual-fallback', audio: audio.id }, owner.token);
  await call('edit', { id: m.id, text: '手工原文', summary: '' }, owner.token);
  assert.equal((await call('state', {}, owner.token)).messages[0].card.confirmed, false);
  assert.equal((await call('process', { id: m.id }, owner.token)).state, 'done');
  assert.equal(asrCalls, 0); assert.deepEqual(inputs, ['手工原文']);
  assert.equal((await call('process', { id: m.id }, owner.token)).state, 'already-done');
  await call('edit', { id: m.id, text: '新原文', summary: '' }, owner.token);
  assert.equal((await call('state', {}, owner.token)).messages[0].aiStatus, 'ready-text');
  await call('process', { id: m.id }, owner.token);
  assert.deepEqual(inputs, ['手工原文', '新原文']);
  assert.equal((await call('state', {}, owner.token)).messages[0].card.summary, '新原文');
});
test('in-flight status is explicit; edits during summary discard stale AI card; confirmed card stays protected', async t => {
  let finish;
  const { call, owner } = await fixture(t, { summarize: () => new Promise(r => { finish = r; }) });
  const m = await call('send', { id: 'summary-revision', text: '初始原文' }, owner.token);
  const pending = call('process', { id: m.id }, owner.token);
  while (!finish) await new Promise(r => setTimeout(r, 5));
  const progress = await call('process', { id: m.id }, owner.token);
  assert.equal(progress.state, 'processing'); assert.ok(progress.retryAfterMs > 0);
  await call('edit', { id: m.id, text: '更新原文', summary: '' }, owner.token);
  finish({ summary: '过期结果' }); assert.equal((await pending).state, 'ready-text');
  assert.equal((await call('state', {}, owner.token)).messages[0].card.summary, '');
  await call('edit', { id: m.id, text: '确认原文', summary: '人工卡片' }, owner.token);
  const retry = call('process', { id: m.id }, owner.token);
  finish = null;
  while (!finish) await new Promise(r => setTimeout(r, 5));
  finish({ summary: 'AI覆盖' }); await retry;
  await call('edit', { id: m.id, text: '再次修改原文', summary: '' }, owner.token);
  const item = (await call('state', {}, owner.token)).messages[0];
  assert.equal(item.card.summary, '人工卡片'); assert.equal(item.card.confirmed, true);
  assert.equal((await call('process', { id: m.id }, owner.token)).state, 'already-done');
});
