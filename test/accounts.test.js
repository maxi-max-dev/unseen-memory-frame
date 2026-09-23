'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server/server');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const credentials = { username: 'fixture01', password: 'fixture-only-password-9364' };
const registration = { ...credentials, mode: 'create', setupCode: 'test-code', name: '测试家庭', nickname: '测试家人一' };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-account-test-'));
  let time = Date.now();
  const app = await createApp({ dataDir: dir, setupCode: 'test-code', accountClock: () => time });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  async function call(action, data = {}, token, expected = 200) {
    const response = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token || ''}` }, body: JSON.stringify({ action, data }) });
    const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
  }
  return { ...app, dir, base, call, time: () => time, advance: value => { time += value; } };
}
test('accounts: real registration, invited second identity, relogin, persistence and legacy frame pairing', async t => {
  const f = await fixture(t), owner = await f.call('register', registration);
  assert.deepEqual(Object.keys(owner).sort(), ['name', 'role', 'room', 'token', 'username']);
  assert.equal(owner.username, 'fixture01'); assert.equal(owner.role, 'owner');
  const invite = await f.call('invite', { role: 'family' }, owner.token);
  const family = await f.call('register', { username: 'FIXTURE02', password: credentials.password, nickname: '测试家人二', mode: 'join', invite: invite.invite });
  assert.equal(family.role, 'family'); assert.equal(family.room, owner.room);
  const photo = await f.call('send', { id: 'shared', text: '来自同一个家庭' }, owner.token);
  const fresh = await f.call('login', { username: ' FIXTURE02 ', password: credentials.password, invite: invite.invite });
  const state = await f.call('state', {}, fresh.token);
  assert.equal(state.messages[0]._id, photo.id); assert.equal(state.username, 'fixture02');
  for (const forbidden of ['credential', 'salt', 'digest', 'account']) assert.equal(JSON.stringify(state).includes('"' + forbidden + '"'), false);
  assert.equal(state.members.find(member => member.name === '测试家人二').username, 'fixture02');
  const paired = await f.call('invite', { role: 'frame' }, owner.token);
  const frame = await f.call('join', { invite: paired.invite, nickname: '测试相框' });
  const frameState = await f.call('state', {}, frame.token);
  assert.equal(frameState.messages.length, 1);
  assert.equal('username' in frameState.members.find(member => member.role === 'frame'), false);
  const recordText = await fs.readFile(path.join(f.dir, 'records.json'), 'utf8');
  assert.equal(recordText.includes(credentials.password), false);
  const accounts = await f.store.list('account'); assert.equal(accounts.length, 2);
  assert.notEqual(accounts[0].credential.salt, accounts[1].credential.salt);
  assert.notEqual(accounts[0].credential.digest, accounts[1].credential.digest);
  const restart = await createApp({ dataDir: f.dir, setupCode: 'test-code' });
  const again = await restart.api('login', credentials);
  assert.equal(again.room, owner.room); assert.equal((await restart.store.list('room')).length, 1);
  assert.equal((await (await fetch(f.base + '/api/health')).json()).accounts, true);
});
test('accounts: invalid grants, frame invitations, password bounds and cross-family login do not grant membership', async t => {
  const f = await fixture(t);
  await f.call('register', { ...registration, setupCode: 'wrong' }, undefined, 403);
  await f.call('register', { ...registration, password: 'short' }, undefined, 400);
  await f.call('register', { ...registration, password: 'x'.repeat(129) }, undefined, 400);
  await f.call('register', { ...registration, username: { $ne: null } }, undefined, 400);
  assert.equal((await f.store.list('account')).length, 0);
  const owner = await f.call('register', registration), frame = await f.call('invite', { role: 'frame' }, owner.token);
  await f.call('register', { username: 'blocked', password: 'fixture-only-password-9364', mode: 'join', invite: frame.invite }, undefined, 403);
  const other = await f.call('create', { setupCode: 'test-code' }), invitation = await f.call('invite', {}, other.token);
  await f.call('login', { ...credentials, invite: invitation.invite }, undefined, 403);
  assert.equal((await f.store.list('session')).length, 2);
  const missing = await f.call('login', { username: 'missing', password: 'fixture-only-password-9364' }, undefined, 401);
  const wrong = await f.call('login', { ...credentials, password: 'wrong-password' }, undefined, 401);
  assert.deepEqual(missing, wrong);
});
test('accounts: concurrent casefold registration cannot overwrite identity or create duplicate rooms', async t => {
  const f = await fixture(t), second = await createApp({ store: f.store, setupCode: 'test-code' });
  const results = await Promise.allSettled([
    f.api('register', registration), second.api('register', { ...registration, username: 'FIXTURE01', password: 'different-pass' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const winner = results[0].status === 'fulfilled' ? registration : { ...registration, password: 'different-pass' };
  const [first, duplicate] = await Promise.all([f.api('register', winner), second.api('register', winner)]);
  assert.equal(first.room, duplicate.room);
  assert.equal((await f.store.list('room')).length, 1); assert.equal((await f.store.list('account')).length, 1);
});
test('accounts: pending room and final-session write failures recover with original password and fixed family', async t => {
  const f = await fixture(t), mutate = f.store.mutate.bind(f.store);
  let roomFailure = true;
  f.store.mutate = async (id, change) => {
    if (roomFailure && id.startsWith('r_')) { roomFailure = false; throw new Error('simulated room write failure'); }
    return mutate(id, change);
  };
  await assert.rejects(f.api('register', registration), /simulated/);
  const pending = (await f.store.list('account'))[0]; assert.equal(pending.status, 'pending');
  await assert.rejects(f.api('login', { ...credentials, password: 'incorrect' }), error => error.status === 401);
  const owner = await f.api('login', credentials); assert.equal(owner.room, pending.room);
  assert.equal((await f.store.list('room')).length, 1);
  const put = f.store.put.bind(f.store); let sessionFailure = true;
  f.store.put = async (doc, create) => { if (doc.kind === 'session' && sessionFailure) { sessionFailure = false; throw new Error('simulated session failure'); } return put(doc, create); };
  await assert.rejects(f.api('register', { ...registration, username: 'fixture03' }), /simulated/);
  const retry = await f.api('login', { username: 'fixture03', password: credentials.password });
  assert.ok(retry.token); assert.equal((await f.store.list('room')).length, 2);
});
test('accounts: pending invited registration accepts a fresh same-family invitation after write failure', async t => {
  const f = await fixture(t), owner = await f.api('create', { setupCode: 'test-code' }), first = await f.api('invite', {}, owner.token);
  const mutate = f.store.mutate.bind(f.store); let failure = true;
  f.store.mutate = (id, change) => mutate(id, current => {
    const next = change(current);
    if (failure && current?.kind === 'account' && next?.status === 'active') { failure = false; throw new Error('activation failure'); }
    return next;
  });
  const join = { ...credentials, mode: 'join', invite: first.invite };
  await assert.rejects(f.api('register', join), /activation failure/);
  await f.store.mutate(first.id, current => ({ ...current, expires: 1 }));
  await assert.rejects(f.api('login', credentials), error => error.status === 403);
  const fresh = await f.api('invite', {}, owner.token);
  const recovered = await f.api('login', { ...credentials, invite: fresh.invite });
  assert.equal(recovered.room, owner.room); assert.equal(recovered.role, 'family');
  assert.equal((await f.store.list('account'))[0].inviteId, fresh.id);
});
test('accounts: logout revokes only its token, member removal blocks relogin and all account sessions', async t => {
  const f = await fixture(t), owner = await f.call('register', registration), invitation = await f.call('invite', {}, owner.token);
  const familyData = { username: 'fixture02', password: credentials.password };
  const family = await f.call('register', { ...familyData, mode: 'join', invite: invitation.invite });
  const another = await f.call('login', familyData);
  await f.call('logout', {}, family.token); await f.call('state', {}, family.token, 401);
  await f.call('state', {}, another.token);
  const member = (await f.call('state', {}, owner.token)).members.find(member => member.name === 'fixture02');
  await f.call('revoke', { id: member.id }, owner.token);
  await f.call('state', {}, another.token, 401); await f.call('login', familyData, undefined, 401);
  await f.call('register', { ...familyData, mode: 'join', invite: invitation.invite }, undefined, 401);
  assert.equal((await f.call('state', {}, owner.token)).members.some(member => member.name === 'fixture02'), false);
  const anotherOwner = await f.call('login', credentials);
  await f.call('revoke', { id: 's_' + hash(anotherOwner.token) }, owner.token, 400);
  const frameInvite = await f.call('invite', { role: 'frame' }, owner.token), frame = await f.call('join', { invite: frameInvite.invite });
  await f.call('logout', {}, frame.token); await f.call('state', {}, frame.token, 401);
});
test('accounts: account tombstone fences private 3D media even if session cleanup fails', async t => {
  const f = await fixture(t), owner = await f.api('register', registration), invitation = await f.api('invite', {}, owner.token);
  const family = await f.api('register', { username: 'fixture02', password: credentials.password, mode: 'join', invite: invitation.invite });
  const scene = 'GS3DC58c4f791ace58141dc9720044e4e771f', link = 'https://app.insta360.com/3dspace/detail/' + scene;
  const message = await f.api('send', { id: 'space', link }, owner.token);
  const file = await f.store.upload('test.sog', Buffer.from('authorization fixture'));
  await f.store.put({ _id: 'sp_' + owner.room, kind: 'spatial', room: owner.room, secret: 'fixture-secret', entries: {
    [scene]: { status: 'ready', sourceURL: link, sourceTitle: '测试', digest: hash('authorization fixture'), bytes: 21, file }
  } });
  const asset = await f.api('spatialAsset', { id: message.id }, family.token);
  assert.equal((await fetch(f.base + asset.url)).status, 200);
  const mutate = f.store.mutate.bind(f.store);
  f.store.mutate = async (id, change) => { if (id.startsWith('s_')) throw new Error('cleanup failure'); return mutate(id, change); };
  await assert.rejects(f.api('revoke', { id: 's_' + hash(family.token) }, owner.token), /cleanup failure/);
  await assert.rejects(f.api('state', {}, family.token), error => error.status === 401);
  assert.equal((await fetch(f.base + asset.url)).status, 404);
});
test('accounts: persistent username/global throttles span app instances, restarts and reset windows', async t => {
  const f = await fixture(t), other = await createApp({ store: f.store, setupCode: 'test-code', accountClock: f.time });
  const failures = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? f : other).api('login', { username: 'guessing', password: 'wrong-password' }).catch(error => error.status)));
  assert.equal(failures.filter(status => status === 401).length, 10); assert.equal(failures.filter(status => status === 429).length, 2);
  const restart = await createApp({ dataDir: f.dir, setupCode: 'test-code', accountClock: f.time });
  await assert.rejects(restart.api('login', { username: 'guessing', password: 'wrong-password' }), error => error.status === 429);
  f.advance(900001);
  await assert.rejects(f.api('login', { username: 'guessing', password: 'wrong-password' }), error => error.status === 401);
  for (let index = 0; index < 59; index++) await assert.rejects(f.api('register', { username: 'x' + index, password: 'short' }), error => error.status === 400);
  await assert.rejects(other.api('register', registration), error => error.status === 429);
  f.advance(60001); assert.ok((await other.api('register', registration)).token);
});
test('accounts: legacy create and username registration share a persistent ten-family quota', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 9; index++) await f.api('create', { setupCode: 'test-code' });
  const outcomes = await Promise.allSettled([f.api('create', { setupCode: 'test-code' }), f.api('register', registration)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.store.list('room')).length, 10);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /10/);
});
