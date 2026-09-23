'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server/server');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
const SCENE = 'GS3DC58c4f791ace58141dc9720044e4e771f';
const SHARE = 'https://app.insta360.com/3dspace/detail/' + SCENE;
const sessionId = token => 's_' + crypto.createHash('sha256').update(token).digest('hex');
function wav() {
  const b = Buffer.alloc(3244); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(3200, 40); return b;
}
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { release, promise }; }
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-state-test-'));
  let time = Date.now(); const clock = () => time;
  const app = await createApp({ dataDir: dir, setupCode: 'test', familyState: { clock } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function call(action, data = {}, token, expected = 200) {
    const response = await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') }, body: JSON.stringify({ action, data }) });
    const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
  }
  const owner = await call('create', { setupCode: 'test' });
  const invite = await call('invite', { role: 'frame' }, owner.token), frame = await call('join', { invite: invite.invite, nickname: '客厅相框' });
  const image = await call('upload', { base64: png.toString('base64') }, owner.token), audio = await call('upload', { base64: wav().toString('base64') }, owner.token);
  async function send(id, fields = {}) { return (await call('send', { id, ...fields }, owner.token)).id; }
  return { ...app, dir, base, call, owner, frame, image, audio, send, clock, advance: ms => { time += ms; } };
}
async function readySpatial(f, scene = SCENE) {
  await f.store.mutate('sp_' + f.owner.room, current => ({ ...(current || { _id: 'sp_' + f.owner.room, kind: 'spatial', room: f.owner.room, secret: 'test' }),
    entries: { ...current?.entries, [scene]: { status: 'ready', stage: 'ready', sourceURL: SHARE.replace(SCENE, scene), bytes: 100, digest: '1'.repeat(64), updatedAt: f.clock() } } }));
}

test('passive session polling is never shown as an active frame report', async t => {
  const f = await fixture(t);
  await f.call('state', {}, f.frame.token);
  const state = await f.call('state', {}, f.owner.token);
  assert.equal(state.members.find(x => x.role === 'frame').online, true);
  assert.equal(state.framePresence.online, false); assert.equal(state.framePresence.activity, null);
  assert.equal(state.framePresence.updatedAt, null); assert.equal(state.framePresence.message, null);
  assert.deepEqual(state.stats, { photos: 0, voices: 0, spatial: 0, replies: 0, memories: 0 });
});
test('explicit frame viewing, listening, recording, spatial and idle are exposed with server timestamps', async t => {
  const f = await fixture(t), id = await f.send('photo', { image: f.image.id, audio: f.audio.id, title: '晚饭', link: SHARE });
  await readySpatial(f);
  for (const activity of ['viewing','listening','recording','spatial']) {
    f.advance(1);
    const report = await f.call('framePresence', { activity, messageId: id, updatedAt: 1, expiresAt: 99999999999999 }, f.frame.token);
    assert.equal(report.accepted, true); assert.equal(report.updatedAt, f.clock()); assert.equal(report.expiresAt, f.clock() + 45000);
    const state = await f.call('state', {}, f.owner.token), p = state.framePresence;
    assert.equal(p.online, true); assert.equal(p.activity, activity); assert.equal(p.messageId, id);
    assert.equal(p.frameName, '客厅相框'); assert.equal(p.message.id, id); assert.equal(p.message.title, '晚饭'); assert.equal(p.message.hasAudio, true);
    assert.deepEqual(Buffer.from(await (await fetch(f.base + p.message.imageURL)).arrayBuffer()), png);
  }
  await f.call('framePresence', { activity: 'idle' }, f.frame.token);
  const idle = (await f.call('state', {}, f.owner.token)).framePresence;
  assert.equal(idle.online, true); assert.equal(idle.activity, 'idle'); assert.equal(idle.messageId, null); assert.equal(idle.message, null);
});
test('frame-only presence validates enums, content capabilities, parent type and family isolation', async t => {
  const f = await fixture(t), photo = await f.send('photo', { image: f.image.id }), text = await f.send('text', { text: '给家人的话' });
  const reply = await f.call('send', { id: 'reply', parent: photo, audio: f.audio.id }, f.frame.token);
  const other = await f.call('create', { setupCode: 'test' }), invite = await f.call('invite', { role: 'frame' }, other.token), foreignFrame = await f.call('join', { invite: invite.invite });
  const familyInvite = await f.call('invite', { role: 'family' }, f.owner.token), family = await f.call('join', { invite: familyInvite.invite });
  for (const token of [f.owner.token, family.token]) await f.call('framePresence', { messageId: photo, activity: 'viewing' }, token, 403);
  await f.call('framePresence', { messageId: photo, activity: 'viewing' }, foreignFrame.token, 404);
  for (const messageId of [{ $ne: null }, [], '', 'missing', reply.id]) await f.call('framePresence', { messageId, activity: 'viewing' }, f.frame.token, 404);
  for (const activity of ['healthy','offline','watching',{},null]) await f.call('framePresence', { messageId: photo, activity }, f.frame.token, 400);
  await f.call('framePresence', { messageId: photo, activity: 'idle' }, f.frame.token, 400);
  await f.call('framePresence', { messageId: photo, activity: 'listening' }, f.frame.token, 400);
  await f.call('framePresence', { messageId: photo, activity: 'spatial' }, f.frame.token, 409);
  await f.call('framePresence', { messageId: text, activity: 'viewing' }, f.frame.token);
  await f.call('framePresence', { messageId: text, activity: 'recording' }, f.frame.token);
  await f.call('remove', { id: photo }, f.owner.token);
  await f.call('framePresence', { messageId: photo, activity: 'viewing' }, f.frame.token, 404);
  assert.equal((await f.call('state', {}, other.token)).framePresence.online, false);
});
test('heartbeat is deduplicated across calls, expires after 45s and passive polling cannot renew it', async t => {
  const f = await fixture(t), id = await f.send('photo', { image: f.image.id });
  const first = await f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token);
  const snapshot = await fs.readFile(path.join(f.dir, 'records.json'), 'utf8');
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token)));
  assert.ok(duplicates.every(result => !result.accepted)); assert.equal(await fs.readFile(path.join(f.dir, 'records.json'), 'utf8'), snapshot);
  f.advance(9999); assert.equal((await f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token)).accepted, false);
  f.advance(1); const refreshed = await f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token); assert.equal(refreshed.accepted, true);
  assert.equal(refreshed.updatedAt - first.updatedAt, 10000);
  f.advance(45000); await f.call('state', {}, f.frame.token);
  const expired = (await f.call('state', {}, f.owner.token)).framePresence;
  assert.equal(expired.online, false); assert.equal(expired.activity, null); assert.equal(expired.message, null); assert.equal(expired.updatedAt, refreshed.updatedAt);
  await f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token);
  assert.equal((await f.call('state', {}, f.owner.token)).framePresence.online, true);
});
test('removed content and unavailable spatial assets cannot remain advertised as activity', async t => {
  const f = await fixture(t), id = await f.send('photo', { image: f.image.id, link: SHARE });
  await readySpatial(f); await f.call('framePresence', { messageId: id, activity: 'spatial' }, f.frame.token);
  await f.store.mutate('sp_' + f.owner.room, record => { record.entries[SCENE].status = 'failed'; return record; });
  let state = await f.call('state', {}, f.owner.token); assert.equal(state.framePresence.activity, 'idle'); assert.equal(state.framePresence.messageId, null);
  await f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token);
  await f.call('remove', { id }, f.owner.token);
  state = await f.call('state', {}, f.owner.token); assert.equal(state.framePresence.activity, 'idle'); assert.equal(state.framePresence.message, null); assert.equal(state.stats.photos, 0);
});
test('expired/revoked sessions cannot report or appear active, including revocation during validation', async t => {
  const f = await fixture(t), id = await f.send('photo', { image: f.image.id }), sid = sessionId(f.frame.token);
  await f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token);
  const get = f.store.get.bind(f.store); let revoke = true;
  f.store.get = async key => {
    const value = await get(key);
    if (key === id && revoke) { revoke = false; await f.store.mutate(sid, current => ({ ...current, revoked: true })); }
    return value;
  };
  await f.call('framePresence', { messageId: id, activity: 'recording' }, f.frame.token, 401);
  assert.equal((await f.call('state', {}, f.owner.token)).framePresence.online, false);
  await f.call('framePresence', { activity: 'idle' }, f.frame.token, 401);
  await f.store.mutate(sid, current => ({ ...current, revoked: false, expires: 1 }));
  await f.call('framePresence', { activity: 'idle' }, f.frame.token, 401);
  assert.equal((await f.call('state', {}, f.owner.token)).framePresence.frameId, null);
});
test('an older request delayed in content validation cannot overwrite a newer idle report', async t => {
  const f = await fixture(t), id = await f.send('photo', { image: f.image.id }), entered = gate(), finish = gate();
  const get = f.store.get.bind(f.store); let delay = true;
  f.store.get = async key => { if (key === id && delay) { delay = false; entered.release(); await finish.promise; } return get(key); };
  const slow = f.api('framePresence', { messageId: id, activity: 'recording' }, f.frame.token);
  await entered.promise; f.advance(1); await f.api('framePresence', { activity: 'idle' }, f.frame.token); finish.release();
  assert.equal((await slow).accepted, false);
  assert.equal((await f.call('state', {}, f.owner.token)).framePresence.activity, 'idle');
});
test('shared-store concurrent heartbeats deduplicate and explicit presence survives a store reload', async t => {
  const f = await fixture(t), id = await f.send('photo', { image: f.image.id });
  const second = await createApp({ store: f.store, setupCode: 'test', familyState: { clock: f.clock } });
  const reports = await Promise.all([f.api('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token), second.api('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token)]);
  assert.equal(reports.filter(report => report.accepted).length, 1);
  const restart = await createApp({ dataDir: f.dir, setupCode: 'test', familyState: { clock: f.clock } });
  assert.equal((await restart.api('state', {}, f.owner.token)).framePresence.messageId, id);
});
test('multiple frames prefer explicit active reports and fall back to idle/expired honestly', async t => {
  const f = await fixture(t), id = await f.send('photo', { image: f.image.id });
  const invite = await f.call('invite', { role: 'frame' }, f.owner.token), second = await f.call('join', { invite: invite.invite, nickname: '卧室相框' });
  await f.call('framePresence', { messageId: id, activity: 'viewing' }, f.frame.token);
  f.advance(10000); await f.call('framePresence', { activity: 'idle' }, second.token);
  assert.equal((await f.call('state', {}, f.owner.token)).framePresence.frameName, '客厅相框');
  f.advance(35000); const idle = (await f.call('state', {}, f.owner.token)).framePresence;
  assert.equal(idle.frameName, '卧室相框'); assert.equal(idle.activity, 'idle');
  await f.call('revoke', { id: sessionId(second.token) }, f.owner.token);
  assert.equal((await f.call('state', {}, f.owner.token)).framePresence.online, false);
});
test('family totals use all visible records beyond the 150-message window, not uploads or retained models', async t => {
  const f = await fixture(t), photo = await f.send('photo', { image: f.image.id, audio: f.audio.id, title: '最早的照片' });
  await f.call('send', { id: 'reply', parent: photo, audio: f.audio.id }, f.frame.token);
  const space1 = await f.send('space1', { link: SHARE }), space2 = await f.send('space2', { link: SHARE });
  await readySpatial(f); await readySpatial(f, 'GS3DC' + '2'.repeat(32)); // private ready asset with no visible referencing message
  for (let i = 0; i < 151; i++) await f.api('send', { id: 'text-' + i, text: '手工记忆 ' + i }, f.owner.token);
  await f.send('failed', { link: SHARE.replace(SCENE, 'GS3DC' + '3'.repeat(32)) });
  const removed = await f.send('removed-photo', { image: f.image.id }); await f.call('remove', { id: removed }, f.owner.token);
  await f.call('framePresence', { messageId: photo, activity: 'viewing' }, f.frame.token);
  let state = await f.call('state', {}, f.owner.token);
  assert.equal(state.messages.length, 150); assert.equal(state.messages.some(message => message._id === photo), false);
  assert.equal(state.framePresence.message.id, photo); assert.equal(state.framePresence.message.title, '最早的照片');
  assert.deepEqual(state.stats, { photos: 1, voices: 2, spatial: 2, replies: 1, memories: 156 });
  await f.call('remove', { id: photo }, f.owner.token); await f.call('remove', { id: space1 }, f.owner.token); await f.call('remove', { id: space2 }, f.owner.token);
  state = await f.call('state', {}, f.owner.token);
  assert.deepEqual(state.stats, { photos: 0, voices: 1, spatial: 0, replies: 1, memories: 153 });
  const other = await f.call('create', { setupCode: 'test' });
  assert.deepEqual((await f.call('state', {}, other.token)).stats, { photos: 0, voices: 0, spatial: 0, replies: 0, memories: 0 });
});
test('existing person relations and manually confirmed memory date/place fields support honest grouping', async t => {
  const f = await fixture(t), id = await f.send('memory', { text: '家人说起往事' });
  await f.call('person', { name: '奶奶', relation: '我的母亲' }, f.owner.token);
  await f.call('person', { name: '奶奶', relation: '妈妈的母亲' }, f.owner.token);
  await f.call('edit', { id, text: '家人修订的文字', title: '往事', summary: '家人确认的摘要', people: ['奶奶'], year: '20世纪80年代', place: '老家' }, f.owner.token);
  const state = await f.call('state', {}, f.owner.token), memory = state.messages.find(message => message._id === id);
  assert.equal(state.people.length, 1); assert.equal(state.people[0].relation, '妈妈的母亲');
  assert.deepEqual(memory.card.people, ['奶奶']); assert.equal(memory.card.year, '20世纪80年代'); assert.equal(memory.card.place, '老家');
  assert.equal(memory.card.confirmed, true); assert.equal(memory.card.source, 'family'); assert.ok(memory.createdAt > 0);
});
