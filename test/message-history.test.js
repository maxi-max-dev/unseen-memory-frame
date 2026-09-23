'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server/server');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-history-test-'));
  const app = await createApp({ dataDir: dir, setupCode: 'history-test-code' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  async function call(action, data = {}, token, expected = 200) {
    const response = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token || ''}` }, body: JSON.stringify({ action, data }) });
    const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
  }
  const owner = await call('create', { setupCode: 'history-test-code' });
  return { ...app, dir, base, call, owner };
}

async function seed(f, count, room = f.owner.room, change = () => ({})) {
  const records = Array.from({ length: count }, (_, index) => ({ _id: `m_${room}_${String(index).padStart(4, '0')}`, kind: 'message', room,
    type: index % 9 === 0 ? 'reply' : 'photo', text: `记忆 ${index}`, image: '', audio: '', link: '', author: 'fixture',
    createdAt: 1700000000000 + Math.floor(index / 7), updatedAt: 1700000000000, ...change(index) }));
  // Deliberately insert in reverse so ties cannot rely on storage iteration order.
  for (const record of [...records].reverse()) await f.store.put(record, true);
  return records;
}

test('history HTTP: legacy state keeps 150 messages and keyset pages cover every live photo/reply exactly once', async t => {
  const f = await fixture(t), records = await seed(f, 283, f.owner.room, index => ({ deleted: index % 23 === 0 }));
  const live = records.filter(record => !record.deleted), state = await f.call('state', {}, f.owner.token);
  assert.deepEqual(state.messages.map(message => message._id), live.slice(-150).map(message => message._id));
  assert.equal(Object.hasOwn(state, 'historyMessages'), false);
  assert.equal(state.messagePage.total, live.length); assert.equal(state.messagePage.hasMore, true);
  const latest = await f.call('history', {}, f.owner.token);
  assert.deepEqual(latest.messages.map(message => message._id), live.slice(-50).map(message => message._id));
  assert.equal(latest.total, live.length);
  const seen = state.messages.map(message => message._id); let cursor = state.messagePage.nextCursor;
  while (cursor) {
    const page = await f.call('history', { cursor, limit: 17 }, f.owner.token);
    assert.ok(page.messages.length > 0 && page.messages.length <= 17);
    assert.equal(page.hasMore, Boolean(page.nextCursor)); assert.equal(page.total, live.length);
    seen.unshift(...page.messages.map(message => message._id)); cursor = page.nextCursor;
  }
  assert.equal(new Set(seen).size, seen.length); assert.deepEqual(seen, live.map(message => message._id));
});

test('history HTTP: identical timestamps, a deleted boundary and concurrent insertion/deletion do not shift older pages', async t => {
  const f = await fixture(t), records = await seed(f, 240, f.owner.room, () => ({ createdAt: 1700000000000 }));
  const state = await f.call('state', {}, f.owner.token);
  await f.call('remove', { id: records[90]._id }, f.owner.token); // The cursor anchor no longer exists in the visible set.
  await f.call('remove', { id: records[12]._id }, f.owner.token);
  const inserted = { ...records[239], _id: `m_${f.owner.room}_zzzz`, text: '翻页中新增' };
  await f.store.put(inserted, true);
  await f.call('edit', { id: records[24]._id, text: '翻页中修订', summary: '保留原排序' }, f.owner.token);
  const older = []; let cursor = state.messagePage.nextCursor;
  while (cursor) {
    const page = await f.call('history', { cursor, limit: 13 }, f.owner.token);
    older.unshift(...page.messages); cursor = page.nextCursor;
  }
  assert.deepEqual(older.map(message => message._id), records.slice(0, 90).filter((_, index) => index !== 12).map(message => message._id));
  assert.equal(new Set(older.map(message => message._id)).size, older.length);
  assert.equal(older.find(message => message._id === records[24]._id).editedText, '翻页中修订');
  const refreshed = await f.call('state', {}, f.owner.token);
  assert.equal(refreshed.messages.at(-1)._id, inserted._id); assert.equal(refreshed.messagePage.total, 239);
});

test('history HTTP: empty/final pages and bounded strict request validation', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('history', {}, f.owner.token), { messages: [], nextCursor: null, hasMore: false, total: 0 });
  assert.deepEqual((await f.call('state', {}, f.owner.token)).messagePage, { nextCursor: null, hasMore: false, total: 0 });
  await seed(f, 3);
  for (const cursor of ['', null]) assert.equal((await f.call('history', { cursor }, f.owner.token)).messages.length, 3);
  for (const limit of [0, -1, 151, 1.1, '50', null, true, {}, []]) await f.call('history', { limit }, f.owner.token, 400);
  for (const cursor of [false, 1, {}, [], 'bad', 'x'.repeat(1025), '!!!!.' + '0'.repeat(64), Buffer.from('not json').toString('base64url') + '.' + '0'.repeat(64)]) await f.call('history', { cursor }, f.owner.token, 400);
  for (const historyIds of [null, {}, 'x', [1], [''], ['bad/id'], ['x'.repeat(161)], Array(301).fill('x')]) await f.call('state', { historyIds }, f.owner.token, 400);
  assert.deepEqual((await f.call('state', { historyIds: Array(300).fill('missing') }, f.owner.token)).historyMessages, []);
  assert.deepEqual((await f.call('state', { historyIds: [] }, f.owner.token)).historyMessages, []);
  const first = await f.call('history', { limit: 1 }, f.owner.token);
  const last = await f.call('history', { cursor: first.nextCursor, limit: 150 }, f.owner.token);
  assert.equal(last.messages.length, 2); assert.equal(last.hasMore, false); assert.equal(last.nextCursor, null);
});

test('history HTTP: signed cursor rejects tampering, malformed payloads and cross-family reuse', async t => {
  const f = await fixture(t), records = await seed(f, 160), state = await f.call('state', {}, f.owner.token);
  const original = state.messagePage.nextCursor, [payload, mac] = original.split('.');
  const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const changed = [...value]; changed[2] += 1;
  await f.call('history', { cursor: Buffer.from(JSON.stringify(changed)).toString('base64url') + '.' + mac }, f.owner.token, 400);
  await f.call('history', { cursor: payload + '.' + (mac[0] === '0' ? '1' : '0') + mac.slice(1) }, f.owner.token, 400);
  const secret = (await f.store.get('r_' + f.owner.room)).historyCursorSecret;
  const signed = raw => { const body = Buffer.from(raw).toString('base64url'); return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('hex'); };
  for (const invalid of [[2, ...value.slice(1)], [...value, 'extra'], [1, value[1], 0.1, value[3]], [1, value[1], -1, value[3]], [1, value[1], value[2], {}], { room: value[1] }]) {
    await f.call('history', { cursor: signed(JSON.stringify(invalid)) }, f.owner.token, 400);
  }
  await f.call('history', { cursor: signed(' ' + JSON.stringify(value)) }, f.owner.token, 400);
  const other = await f.call('create', { setupCode: 'history-test-code' });
  await f.call('history', { cursor: original }, other.token, 400);
  const isolated = await f.call('state', { historyIds: [records[0]._id, records[159]._id] }, other.token);
  assert.deepEqual(isolated.messages, []); assert.deepEqual(isolated.historyMessages, []);
  assert.equal(JSON.stringify(state).includes(secret), false);
});

test('history HTTP: hydration refreshes loaded older edits, deletions, media URLs and spatial state without leaking other records', async t => {
  const f = await fixture(t), records = await seed(f, 154);
  let currentTime = Date.now(), issued = 0;
  t.mock.method(Date, 'now', () => currentTime);
  f.store.url = async file => `https://media.invalid/${file}?version=${++issued}`;
  await f.store.put({ _id: 'f_old_image', kind: 'file', room: f.owner.room, file: 'old.jpg', mime: 'image/jpeg' });
  await f.store.put({ _id: 'f_old_audio', kind: 'file', room: f.owner.room, file: 'old.wav', mime: 'audio/wav' });
  const scene = 'GS3DC58c4f791ace58141dc9720044e4e771f', link = 'https://app.insta360.com/3dspace/detail/' + scene;
  await f.store.mutate(records[0]._id, record => ({ ...record, image: 'old_image', audio: 'old_audio', link }));
  await f.store.put({ _id: 'sp_' + f.owner.room, kind: 'spatial', room: f.owner.room, entries: { [scene]: { status: 'ready', bytes: 123, digest: 'fixture', sourceURL: link } } });
  const state = await f.call('state', {}, f.owner.token), history = await f.call('history', { cursor: state.messagePage.nextCursor }, f.owner.token);
  const old = history.messages.find(message => message._id === records[0]._id);
  assert.match(old.imageURL, /old\.jpg/); assert.match(old.audioURL, /old\.wav/); assert.equal(old.spatial.status, 'ready');
  await f.call('edit', { id: old._id, title: '已修订', text: '最新原话', summary: '最新卡片', people: ['奶奶'], year: '1980' }, f.owner.token);
  await f.call('remove', { id: records[1]._id }, f.owner.token);
  await f.store.mutate('sp_' + f.owner.room, record => ({ ...record, entries: { [scene]: { status: 'failed', error: '测试状态变化' } } }));
  const other = await f.call('create', { setupCode: 'history-test-code' }), foreign = await seed(f, 1, other.room);
  await f.call('person', { name: '同家庭人物' }, f.owner.token);
  const person = (await f.store.list('person', f.owner.room))[0];
  currentTime += 600001; // Exercise the real ten-minute URL refresh threshold, without waiting.
  const refreshed = await f.call('state', { historyIds: [old._id, old._id, records[1]._id, records[153]._id, foreign[0]._id, person._id, 'f_old_image'] }, f.owner.token);
  assert.equal(refreshed.messages.length, 150); assert.equal(refreshed.historyMessages.length, 1);
  const updated = refreshed.historyMessages[0];
  assert.equal(updated._id, old._id); assert.equal(updated.title, '已修订'); assert.equal(updated.editedText, '最新原话');
  assert.deepEqual(updated.card.people, ['奶奶']); assert.equal(updated.card.year, '1980');
  assert.notEqual(updated.imageURL, old.imageURL); assert.notEqual(updated.audioURL, old.audioURL);
  assert.equal(updated.spatial.status, 'failed'); assert.equal(refreshed.messagePage.total, 153);
});

test('history HTTP: every page and hydration check session expiry, logout and disabled account membership', async t => {
  const f = await fixture(t); await seed(f, 151);
  const invite = await f.call('invite', { role: 'frame' }, f.owner.token), frame = await f.call('join', { invite: invite.invite });
  const page = await f.call('history', { limit: 1 }, frame.token); assert.equal(page.messages.length, 1);
  await f.call('logout', {}, frame.token);
  await f.call('history', { cursor: page.nextCursor }, frame.token, 401);
  await f.call('state', { historyIds: [page.messages[0]._id] }, frame.token, 401);
  const expired = await f.call('join', { invite: invite.invite });
  await f.store.mutate('s_' + hash(expired.token), session => ({ ...session, expires: 1 }));
  await f.call('history', {}, expired.token, 401); await f.call('history', {}, undefined, 401);
  const familyInvite = await f.call('invite', {}, f.owner.token);
  const account = await f.call('register', { username: 'history01', password: 'history-test-password', mode: 'join', invite: familyInvite.invite });
  const accountPage = await f.call('history', { limit: 1 }, account.token);
  const accountSession = await f.store.get('s_' + hash(account.token));
  await f.store.mutate(accountSession.account, record => ({ ...record, revoked: true }));
  await f.call('history', { cursor: accountPage.nextCursor }, account.token, 401);
  await f.call('state', { historyIds: [accountPage.messages[0]._id] }, account.token, 401);
  assert.equal((await f.store.get(accountSession._id)).revoked, undefined); // Account check, not session cleanup, denied access.
});

test('history: concurrent app instances establish one family key and cursors survive process restart', async t => {
  const f = await fixture(t); await seed(f, 170);
  const second = await createApp({ store: f.store, setupCode: 'history-test-code' });
  const [one, two] = await Promise.all([f.api('state', {}, f.owner.token), second.api('state', {}, f.owner.token)]);
  assert.equal(one.messagePage.nextCursor, two.messagePage.nextCursor);
  const before = (await f.store.get('r_' + f.owner.room)).historyCursorSecret;
  assert.match(before, /^[a-f0-9]{64}$/);
  const restarted = await createApp({ dataDir: f.dir, setupCode: 'history-test-code' });
  const older = await restarted.api('history', { cursor: one.messagePage.nextCursor }, f.owner.token);
  assert.equal(older.messages.length, 20); assert.equal(older.hasMore, false);
  assert.equal((await restarted.api('state', {}, f.owner.token)).messagePage.nextCursor, one.messagePage.nextCursor);
  assert.equal((await restarted.store.get('r_' + f.owner.room)).historyCursorSecret, before);
});
