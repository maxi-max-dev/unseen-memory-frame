'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ready = import('../scripts/portable-content.mjs');
const sha = (value) => createHash('sha256').update(value).digest('hex');

test('portable content strips temporary URLs, cloud author/session and AI lease fields while preserving content', async () => {
  const { cleanMessage } = await ready;
  const message = { _id: 'm_local_one', kind: 'message', room: 'local', type: 'photo', title: '旧照片', text: '文字',
    image: 'photo', audio: 'voice', createdAt: 100, updatedAt: 120, author: 'cloud-session-id', imageURL: 'https://example.invalid/signed',
    audioURL: 'https://example.invalid/audio', aiLease: 'not-for-export', aiUntil: 999, card: { title: '标题', year: '1990', people: ['妈妈'], extra: 'not-a-card-field' } };
  const clean = cleanMessage(message, 'local');
  assert.equal(clean.author, 'portable-import');
  assert.equal(clean.image, 'photo'); assert.equal(clean.audio, 'voice'); assert.equal(clean.createdAt, 100);
  assert.deepEqual(clean.card, { title: '标题', year: '1990', people: ['妈妈'] });
  for (const key of ['imageURL', 'audioURL', 'aiLease', 'aiUntil']) assert.equal(Object.hasOwn(clean, key), false);
  assert.throws(() => cleanMessage(message, 'another-room'));
  assert.throws(() => cleanMessage({ ...message, deleted: true }, 'local'));
});

test('portable cloud API allowlist refuses all content writes before making a request', async () => {
  const { request } = await ready;
  for (const action of ['register', 'create', 'join', 'upload', 'send', 'spatialImport', 'delete', 'aiChat', 'contactRequest']) {
    await assert.rejects(request('http://127.0.0.1:1', action), /allowlist/);
  }
});

test('portable seed restores through actual isolated HTTP with both fresh accounts, media and 4 MiB model chunks', async () => {
  const { makeSeed, verifyRestore } = await ready;
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-content-test-'));
  try {
    const room = { id: 'local-preview', name: '相框测试家庭' };
    const image = Buffer.from('portable image bytes'); const audio = Buffer.from('portable audio bytes');
    const model = Buffer.alloc(4 * 1024 * 1024 + 51, 17);
    const sourceURL = 'https://app.insta360.com/3dspace/detail/GS3DC' + 'a'.repeat(32);
    const snapshot = { schemaVersion: 1, room,
      messages: [
        { _id: 'm_one', kind: 'message', room: room.id, type: 'photo', title: '旧相册', text: '原文', createdAt: 1000, updatedAt: 1001,
          image: 'image-one', audio: '', link: sourceURL, parent: '', name: '妈妈', author: 'portable-import', card: { title: '旧相册', year: '1990', people: ['妈妈'], confirmed: true } },
        { _id: 'm_two', kind: 'message', room: room.id, type: 'reply', title: '回应', text: '', transcription: '声音文字', createdAt: 2000, updatedAt: 2001,
          image: 'image-one', audio: 'audio-one', link: '', parent: 'm_one', name: '爸爸', author: 'portable-import' },
      ], people: [{ _id: 'p_one', kind: 'person', room: room.id, name: '妈妈', relation: '母亲' }],
      receipts: [{ message: 'm_one', deliveredAt: 3000, playedAt: 4000 }],
      media: [
        { id: 'image-one', type: 'image', mime: 'image/png', file: sha(image) + '.png', bytes: image.length, sha256: sha(image) },
        { id: 'audio-one', type: 'audio', mime: 'audio/wav', file: sha(audio) + '.wav', bytes: audio.length, sha256: sha(audio) },
      ], models: [{ format: 'sog', sourceURL, sourceTitle: '空间', file: sha(model) + '.sog', bytes: model.length, digest: sha(model), messageIds: ['m_one'] }] };
    await makeSeed(output, snapshot, snapshot.media, snapshot.models);
    await fs.writeFile(path.join(output, 'snapshot.json'), JSON.stringify(snapshot));
    for (const [name, bytes] of [[snapshot.media[0].file, image], [snapshot.media[1].file, audio], [snapshot.models[0].file, model]]) {
      await fs.writeFile(path.join(output, 'seed-data/media', name), bytes);
    }
    const recordsBefore = await fs.readFile(path.join(output, 'seed-data/records.json'));
    const records = JSON.parse(recordsBefore);
    assert.equal(Object.values(records).filter((r) => r.kind === 'account').length, 2);
    assert.equal(Object.values(records).filter((r) => ['session', 'invite', 'download'].includes(r.kind)).length, 0);
    const verified = await verifyRestore(output);
    assert.equal(verified.passed, true); assert.equal(verified.accounts, 2); assert.equal(verified.messages, 2);
    assert.equal(verified.people, 1); assert.equal(verified.receipts, 1); assert.equal(verified.media.length, 2);
    assert.equal(verified.models.length, 2); assert.ok(verified.models.every((m) => m.parts.length === 2 && m.parts.every((p) => p.status === 206 && p.bytes <= 4 * 1024 * 1024)));
    assert.equal(verified.localSessionsRevoked, 2); assert.equal(verified.localServerStopped, true); assert.equal(verified.seedUnchanged, true);
    assert.deepEqual(await fs.readFile(path.join(output, 'seed-data/records.json')), recordsBefore);
  } finally {
    assert.equal(path.dirname(output), os.tmpdir()); assert.ok(path.basename(output).startsWith('portable-content-test-'));
    await fs.rm(output, { recursive: true, force: true });
  }
});
