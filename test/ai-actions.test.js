'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../server/store');
const { createActions, TTL, LEASE, MAX_ACTIONS, MAX_PREPARES } = require('../server/ai-actions');

const httpError = status => Object.assign(new Error('fixture permission'), { status });
const denied = status => error => error.status === status;
async function fixture(t, { callSupport = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-ai-actions-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new LocalStore(dir); await store.init();
  let time = 1000000;
  const owner = { _id: 's_owner', kind: 'session', account: 'u_owner', room: 'home', role: 'owner', name: '甲', expires: time + 86400000 };
  const second = { ...owner, _id: 's_second' };
  const outside = { ...owner, _id: 's_outside', account: 'u_outside', room: 'elsewhere' };
  const frame = { ...owner, _id: 's_frame', account: undefined, role: 'frame' };
  const target = { ...owner, _id: 's_target', account: 'u_target', role: 'family', name: '乙' };
  for (const s of [owner, second, outside, frame, target]) await store.put(s, true);
  const tokens = new Map([['owner-token', owner._id], ['second-token', second._id], ['outside-token', outside._id], ['frame-token', frame._id]]);
  const activeAccounts = new Set(['u_owner', 'u_outside', 'u_target']);
  async function authenticate(token) {
    const s = await store.get(tokens.get(token));
    if (!s || s.revoked || s.expires <= time || (s.account && !activeAccounts.has(s.account))) throw httpError(401);
    return s;
  }
  async function roster(s) {
    return (await store.list('session', s.room)).filter(x => !x.revoked && x.expires > time && (!x.account || activeAccounts.has(x.account)))
      .map(x => ({ id: x.account || x._id, name: x.name, role: x.role }));
  }
  for (let i = 1; i <= 5; i++) {
    await store.put({ _id: 'f_photo' + i, id: 'photo' + i, kind: 'file', room: 'home', file: 'photo' + i + '.jpg', mime: 'image/jpeg', bytes: 100, digest: 'digest' + i });
    await store.put({ _id: 'm_home_' + i, kind: 'message', room: 'home', image: 'photo' + i, text: '照片' + i });
  }
  await store.put({ _id: 'f_voice', id: 'voice', kind: 'file', room: 'home', file: 'voice.wav', mime: 'audio/wav', bytes: 32044, digest: 'voice-digest' });
  const effects = new Map(), sends = [], contacts = [], calls = [];
  const hooks = {}, callSettings = { enabled: true, reason: '家庭语音通话尚未配置受控中继' };
  async function send(data, token) {
    await authenticate(token); sends.push(structuredClone(data));
    await hooks.beforeSend?.(data);
    const id = 'm_home_' + data.id;
    if (!effects.has(id)) effects.set(id, structuredClone(data));
    await hooks.afterSend?.(data);
    return { id, saved: true };
  }
  async function contactRequest(data, s) {
    if (!(await roster(s)).some(x => x.id === data.targetId)) throw httpError(404);
    contacts.push(structuredClone(data));
    await hooks.beforeContact?.(data);
    effects.set(data.requestId, structuredClone(data));
    await hooks.afterContact?.(data);
    return { members: [], requests: [{ id: 'contact-result' }] };
  }
  async function callCapabilities(s) {
    await hooks.capabilities?.(s);
    return { audioCall: callSettings.enabled, reason: callSettings.reason };
  }
  async function callRequest(data, s) {
    const current = await store.get(s._id);
    if (!current || current.revoked || (current.account && !activeAccounts.has(current.account))) throw httpError(401);
    if (callSettings.enabled !== true) throw httpError(503);
    if (!(await roster(s)).some(x => x.id === data.targetId)) throw httpError(404);
    calls.push(structuredClone(data));
    await hooks.beforeCall?.(data);
    const callId = 'call_' + data.requestId;
    effects.set(callId, structuredClone(data));
    await hooks.afterCall?.(data);
    return { callId, call: { id: callId, status: 'ringing' }, serverTime: time };
  }
  const options = { authenticate, roster, send, contactRequest, ...(callSupport ? { callCapabilities, callRequest } : {}), clock: () => time };
  const make = (overrides = {}) => createActions(store, { ...options, ...overrides }), actions = make();
  const call = (action, data, s = owner, token = 'owner-token', module = actions) => module.handle(action, data, s, token);
  const prepare = data => call('aiActionPrepare', { kind: 'message', targetId: target.account, text: '明天见', ...data });
  const confirm = (item, module = actions) => call('aiActionConfirm', { actionId: item.actionId, version: item.version }, owner, 'owner-token', module);
  const get = item => call('aiActionGet', { actionId: item.actionId });
  return { store, owner, target, second, outside, frame, activeAccounts, hooks, effects, sends, contacts, calls, callSettings, make, call, prepare, confirm, get,
    advance: ms => { time += ms; }, time: () => time };
}

test('actions: preparation is inert and canonical, each selected photo becomes an explicitly shared message', async t => {
  const f = await fixture(t);
  const p = await f.prepare({ text: ' 下周一起吃饭 ', messageIds: ['m_home_1', 'm_home_2'], audioId: 'voice' });
  assert.equal(p.status, 'ready'); assert.equal(p.version, 1); assert.equal(p.text, '下周一起吃饭');
  assert.equal(p.visibility, 'family'); assert.equal(p.targetName, '乙'); assert.equal(p.completed, 0);
  assert.deepEqual(p.photos, [{ messageId: 'm_home_1', imageId: 'photo1' }, { messageId: 'm_home_2', imageId: 'photo2' }]);
  assert.equal(f.effects.size, 0); assert.equal(JSON.stringify(p).includes('.jpg'), false);
  const result = await f.confirm(p);
  assert.equal(result.status, 'completed'); assert.equal(result.completed, 2); assert.equal(f.effects.size, 2);
  assert.equal(f.sends[0].text, '给乙的留言（家庭共享）\n下周一起吃饭'); assert.equal(f.sends[0].audio, 'voice');
  assert.equal(f.sends[1].text, '给乙的留言（家庭共享）'); assert.equal(f.sends[1].audio, '');
  assert.deepEqual(f.sends.map(x => x.image), ['photo1', 'photo2']);
  assert.deepEqual(await f.confirm(p), result); assert.equal(f.sends.length, 2);
  const persisted = JSON.stringify(await f.store.list('ai-actions'));
  assert.equal(persisted.includes('owner-token'), false);
});

test('actions: missing recipient/content requires clarification; calls require explicit reminder mode', async t => {
  const f = await fixture(t), incomplete = await f.prepare({ targetId: '', text: '' });
  assert.equal(incomplete.status, 'draft'); assert.deepEqual(incomplete.needs, ['target', 'content']);
  await assert.rejects(f.confirm(incomplete), denied(400));
  const call = await f.prepare({ kind: 'contact' });
  assert.deepEqual(call.needs, ['mode']); assert.equal(call.status, 'draft');
  await assert.rejects(f.confirm(call), denied(400));
  await assert.rejects(f.prepare({ kind: 'contact', mode: 'video-call' }), denied(400));
  await assert.rejects(f.prepare({ kind: 'contact', mode: 'audio-call' }), denied(503));
  const reminder = await f.prepare({ kind: 'contact', mode: 'request-only', actionId: call.actionId, version: call.version });
  assert.equal(reminder.version, 2); assert.equal(reminder.visibility, 'participants'); assert.equal(reminder.audioCall, false);
  assert.equal(f.contacts.length, 0);
  const result = await f.confirm(reminder); assert.equal(result.results[0].kind, 'contact'); assert.equal(f.contacts.length, 1);
  await f.confirm(reminder); assert.equal(f.contacts.length, 1);
});

test('actions: strict validation rejects arbitrary URLs, invalid photos/audio, oversized input and unknown fields', async t => {
  const f = await fixture(t);
  for (const data of [{ text: 'x'.repeat(2701) }, { targetId: 'https://example.com' }, { messageIds: ['https://example.com'] },
    { messageIds: ['m_home_1', 'm_home_1'] }, { messageIds: ['m_home_1', 'm_home_2', 'm_home_3', 'm_home_4', 'm_home_5'] },
    { messageIds: 'm_home_1' }, { audioId: 'https://example.com' }, { extra: true }]) await assert.rejects(f.prepare(data), denied(400));
  for (const data of [{ targetId: 'person_mother' }, { targetId: 'u_owner' }, { messageIds: ['m_missing'] }, { audioId: 'missing' },
    { audioId: 'photo1' }, { messageIds: ['m_home_4'] }]) {
    if (data.messageIds?.[0] === 'm_home_4') await f.store.mutate('m_home_4', x => ({ ...x, room: 'elsewhere' }));
    await assert.rejects(f.prepare(data), denied(404));
  }
  assert.equal(f.effects.size, 0);
});

test('actions: confirm requires current card id/version and does not accept text or execution edits', async t => {
  const f = await fixture(t), p = await f.prepare();
  for (const data of [{ text: '好' }, { actionId: p.actionId }, { actionId: p.actionId, version: 0 },
    { actionId: p.actionId, version: p.version, text: '替换内容' }, { actionId: p.actionId, version: p.version, targetId: 's_frame' }]) {
    await assert.rejects(f.call('aiActionConfirm', data), denied(400));
  }
  assert.equal(f.effects.size, 0);
});

test('actions: candidates are bound to family, account and the exact session, including reads and cancellation', async t => {
  const f = await fixture(t), p = await f.prepare();
  for (const [session, token] of [[f.second, 'second-token'], [f.outside, 'outside-token']]) {
    await assert.rejects(f.call('aiActionGet', { actionId: p.actionId }, session, token), denied(404));
    for (const action of ['aiActionConfirm', 'aiActionCancel']) await assert.rejects(f.call(action, { actionId: p.actionId, version: p.version }, session, token), denied(404));
  }
  await assert.rejects(f.call('aiActionGet', { actionId: p.actionId }, f.owner, 'second-token'), denied(401));
  await f.store.mutate(f.owner._id, s => ({ ...s, account: 'u_outside' }));
  await assert.rejects(f.get(p), denied(401)); assert.equal(f.effects.size, 0);
});

test('actions: editing increases version, invalidates old confirms and preserves one actionable candidate', async t => {
  const f = await fixture(t), p = await f.prepare();
  const updated = await f.prepare({ actionId: p.actionId, version: p.version, text: '周末见', messageIds: ['m_home_3'] });
  assert.equal(updated.version, 2); assert.equal(updated.actionId, p.actionId);
  await assert.rejects(f.confirm(p), denied(409));
  await assert.rejects(f.prepare({ actionId: p.actionId, version: p.version, text: '旧版本' }), denied(409));
  assert.equal((await f.get(p)).text, '周末见'); await f.confirm(updated);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].image, 'photo3');
  await assert.rejects(f.prepare({ actionId: updated.actionId, version: updated.version }), denied(409));
});

test('actions: session, account, target revocation and changed target names prevent later confirmation', async t => {
  const f = await fixture(t), p = await f.prepare();
  await f.store.mutate(f.owner._id, x => ({ ...x, revoked: true }));
  await assert.rejects(f.confirm(p), denied(401));
  await f.store.mutate(f.owner._id, x => ({ ...x, revoked: false }));
  f.activeAccounts.delete('u_owner'); await assert.rejects(f.confirm(p), denied(401)); f.activeAccounts.add('u_owner');
  await f.store.mutate(f.target._id, x => ({ ...x, revoked: true }));
  await assert.rejects(f.confirm(p), denied(404));
  await f.store.mutate(f.target._id, x => ({ ...x, revoked: false, name: '新称呼' }));
  await assert.rejects(f.confirm(p), denied(409)); assert.equal(f.effects.size, 0);
});

test('actions: removed photos, replaced photo bytes and revoked audio are rechecked against the prepared preview', async t => {
  const f = await fixture(t), photo = await f.prepare({ messageIds: ['m_home_1'] });
  await f.store.mutate('m_home_1', x => ({ ...x, deleted: true })); await assert.rejects(f.confirm(photo), denied(404));
  await f.store.mutate('m_home_1', x => ({ ...x, deleted: false }));
  await f.store.mutate('f_photo1', x => ({ ...x, digest: 'replacement' })); await assert.rejects(f.confirm(photo), denied(409));
  const voice = await f.prepare({ audioId: 'voice' });
  await f.store.mutate('f_voice', x => ({ ...x, revoked: true })); await assert.rejects(f.confirm(voice), denied(404));
  assert.equal(f.effects.size, 0);
});

test('actions: durable CAS blocks concurrent confirmations across separate module instances', async t => {
  const f = await fixture(t), p = await f.prepare();
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.hooks.beforeSend = async () => { enter(); await gate; };
  const first = f.confirm(p); await entered;
  await assert.rejects(f.confirm(p, f.make()), denied(409));
  await assert.rejects(f.call('aiActionCancel', { actionId: p.actionId, version: p.version }), denied(409));
  release(); assert.equal((await first).status, 'completed'); assert.equal(f.effects.size, 1); assert.equal(f.sends.length, 1);
});

test('actions: an ambiguous send response retries the same durable id and cannot be edited after execution started', async t => {
  const f = await fixture(t), p = await f.prepare(); let once = true;
  f.hooks.afterSend = () => { if (once) { once = false; throw new Error('simulated response lost after save'); } };
  await assert.rejects(f.confirm(p), /response lost/);
  assert.equal(f.effects.size, 1); assert.equal((await f.get(p)).status, 'failed');
  await assert.rejects(f.prepare({ actionId: p.actionId, version: p.version, text: '改为别的' }), denied(409));
  assert.equal((await f.confirm(p, f.make())).status, 'completed'); assert.equal(f.effects.size, 1);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[0].id, f.sends[1].id);
});

test('actions: partial multiphoto execution resumes the remaining item without replaying completed steps', async t => {
  const f = await fixture(t), p = await f.prepare({ messageIds: ['m_home_1', 'm_home_2'] }); let once = true;
  f.hooks.beforeSend = data => { if (data.image === 'photo2' && once) { once = false; throw new Error('simulated unavailable'); } };
  await assert.rejects(f.confirm(p), /unavailable/);
  const failed = await f.get(p); assert.equal(failed.status, 'failed'); assert.equal(failed.completed, 1); assert.match(failed.error, /部分/);
  const result = await f.confirm(p, f.make()); assert.equal(result.completed, 2); assert.equal(f.effects.size, 2);
  assert.deepEqual(f.sends.map(x => x.image), ['photo1', 'photo2', 'photo2']);
});

test('actions: partial retry ignores deleted completed sources but still checks remaining media, target and session', async t => {
  const f = await fixture(t), p = await f.prepare({ text: '', messageIds: ['m_home_1', 'm_home_2'], audioId: 'voice' }); let once = true;
  f.hooks.beforeSend = data => { if (data.image === 'photo2' && once) { once = false; throw new Error('second photo unavailable'); } };
  await assert.rejects(f.confirm(p), /second photo unavailable/);
  const first = (await f.get(p)).results[0]; assert.equal(f.effects.size, 1);
  await f.store.mutate('m_home_1', x => ({ ...x, deleted: true }));
  await f.store.mutate('f_photo1', x => ({ ...x, revoked: true }));
  await f.store.mutate('f_voice', x => ({ ...x, revoked: true }));
  await f.store.mutate('m_home_2', x => ({ ...x, deleted: true }));
  await assert.rejects(f.confirm(p), denied(404)); assert.equal(f.sends.length, 2);
  await f.store.mutate('m_home_2', x => ({ ...x, deleted: false }));
  await f.store.mutate('f_photo2', x => ({ ...x, digest: 'changed-remaining-photo' }));
  await assert.rejects(f.confirm(p), denied(409)); assert.equal(f.sends.length, 2);
  await f.store.mutate('f_photo2', x => ({ ...x, digest: 'digest2' }));
  await f.store.mutate(f.target._id, x => ({ ...x, revoked: true })); await assert.rejects(f.confirm(p), denied(404));
  await f.store.mutate(f.target._id, x => ({ ...x, revoked: false }));
  await f.store.mutate(f.owner._id, x => ({ ...x, revoked: true })); await assert.rejects(f.confirm(p), denied(401));
  await f.store.mutate(f.owner._id, x => ({ ...x, revoked: false }));
  const result = await f.confirm(p, f.make());
  assert.equal(result.status, 'completed'); assert.equal(result.completed, 2); assert.deepEqual(result.results[0], first);
  assert.equal(f.effects.size, 2); assert.deepEqual(f.sends.map(x => x.image), ['photo1', 'photo2', 'photo2']);
  assert.equal(f.sends[2].audio, '');
});

test('actions: permissions and remaining media are rechecked between sequential sends', async t => {
  const f = await fixture(t), p = await f.prepare({ messageIds: ['m_home_1', 'm_home_2'] });
  f.hooks.afterSend = async data => { if (data.image === 'photo1') await f.store.mutate('m_home_2', x => ({ ...x, deleted: true })); };
  await assert.rejects(f.confirm(p), denied(404)); assert.equal(f.sends.length, 1); assert.equal((await f.get(p)).completed, 1);
  await assert.rejects(f.confirm(p), denied(404)); assert.equal(f.sends.length, 1);
  await f.store.mutate('m_home_2', x => ({ ...x, deleted: false }));
  await f.confirm(p); assert.equal(f.effects.size, 2);
});

test('actions: a crashed lease resumes safely, while an active lease cannot be cancelled', async t => {
  const f = await fixture(t), p = await f.prepare();
  const doc = (await f.store.list('ai-actions'))[0];
  await f.store.mutate(doc._id, x => ({ ...x, entries: x.entries.map(item => ({ ...item, status: 'processing', startedAt: f.time(), lease: 'crashed', leaseUntil: f.time() + LEASE })) }));
  await assert.rejects(f.confirm(p, f.make()), denied(409)); f.advance(LEASE + 1);
  await assert.rejects(f.call('aiActionCancel', { actionId: p.actionId, version: p.version }), denied(409));
  await f.confirm(p, f.make()); assert.equal(f.effects.size, 1);
});

test('actions: cancelled and expired cards never execute; a failed partial cancellation warns it cannot retract sends', async t => {
  const f = await fixture(t), p = await f.prepare();
  const cancelled = await f.call('aiActionCancel', { actionId: p.actionId, version: p.version }); assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(f.confirm(p), denied(409)); await assert.rejects(f.prepare({ actionId: p.actionId, version: p.version }), denied(409));
  const expired = await f.prepare(); f.advance(TTL + 1); assert.equal((await f.get(expired)).status, 'expired');
  await assert.rejects(f.confirm(expired), denied(410));
  const partial = await f.prepare({ messageIds: ['m_home_1', 'm_home_2'] });
  f.hooks.beforeSend = data => { if (data.image === 'photo2') throw new Error('failure'); };
  await assert.rejects(f.confirm(partial), /failure/);
  const stopped = await f.call('aiActionCancel', { actionId: partial.actionId, version: partial.version });
  assert.equal(stopped.completed, 1); assert.match(stopped.error, /不会撤回/);
  await assert.rejects(f.confirm(partial), denied(409)); assert.equal(f.effects.size, 1);
});

test('actions: contact retry preserves its request id and never interprets it as audio calling', async t => {
  const f = await fixture(t), p = await f.prepare({ kind: 'contact', mode: 'request-only' }); let once = true;
  f.hooks.afterContact = () => { if (once) { once = false; throw new Error('contact response lost'); } };
  await assert.rejects(f.confirm(p), /response lost/); await f.confirm(p, f.make());
  assert.equal(f.contacts.length, 2); assert.equal(f.contacts[0].requestId, f.contacts[1].requestId); assert.equal(f.effects.size, 1);
  assert.deepEqual(Object.keys(f.contacts[0]).sort(), ['requestId', 'targetId']);
});

test('actions: frame confirmation is authorized for the internal send adapter without exposing a bypass flag', async t => {
  const f = await fixture(t), p = await f.call('aiActionPrepare', { kind: 'message', targetId: f.target.account, text: '给你的问候' }, f.frame, 'frame-token');
  await f.call('aiActionConfirm', { actionId: p.actionId, version: p.version }, f.frame, 'frame-token');
  assert.equal(f.effects.size, 1); assert.equal('confirmedAction' in f.sends[0], false);
});

test('actions: pending candidates and prepare frequency have persisted limits', async t => {
  const f = await fixture(t);
  for (let i = 0; i < MAX_ACTIONS; i++) await f.prepare();
  await assert.rejects(f.prepare(), denied(429));
  const doc = (await f.store.list('ai-actions'))[0], first = doc.entries[0];
  await f.call('aiActionCancel', { actionId: first.actionId, version: first.version });
  let editable = await f.prepare(); assert.equal((await f.store.list('ai-actions'))[0].entries.length, MAX_ACTIONS);
  for (let i = MAX_ACTIONS + 1; i < MAX_PREPARES; i++) editable = await f.prepare({ actionId: editable.actionId, version: editable.version });
  await assert.rejects(f.prepare({ actionId: editable.actionId, version: editable.version }), denied(429));
});

test('actions: audio-call preview names the method without ringing; explicit confirmation returns the one call id', async t => {
  const f = await fixture(t, { callSupport: true }), p = await f.prepare({ kind: 'contact', mode: 'audio-call' });
  assert.equal(p.status, 'ready'); assert.equal(p.audioCall, true); assert.equal(p.mode, 'audio-call');
  assert.equal(p.visibility, 'participants'); assert.deepEqual(p.needs, []);
  assert.equal(f.calls.length, 0); assert.equal(f.contacts.length, 0); assert.equal(f.effects.size, 0);
  assert.equal('connected' in p, false); assert.equal('callId' in p, false);
  const result = await f.confirm(p);
  assert.equal(result.status, 'completed'); assert.equal(result.completed, 1);
  assert.equal(p.callRequestId, f.calls[0].requestId); assert.equal(result.callRequestId, p.callRequestId);
  assert.deepEqual(result.results[0], { kind: 'contact', mode: 'audio-call', callId: 'call_' + f.calls[0].requestId, requestId: f.calls[0].requestId });
  assert.equal(result.audioCall, true); assert.equal(JSON.stringify(result).includes('connected'), false);
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['requestId', 'targetId']); assert.equal(f.calls[0].targetId, f.target.account);
  assert.equal(f.contacts.length, 0); assert.equal(f.sends.length, 0);
  assert.deepEqual(await f.confirm(p, f.make()), result); assert.equal(f.calls.length, 1);
});

test('actions: audio-call capability is checked on prepare and every confirm, with no reminder fallback', async t => {
  const f = await fixture(t, { callSupport: true });
  f.callSettings.enabled = false;
  await assert.rejects(f.prepare({ kind: 'contact', mode: 'audio-call' }), e => e.status === 503 && e.message === f.callSettings.reason);
  assert.equal((await f.store.list('ai-actions')).length, 0);
  f.callSettings.enabled = true;
  const p = await f.prepare({ kind: 'contact', mode: 'audio-call' });
  f.callSettings.enabled = false; await assert.rejects(f.confirm(p), denied(503));
  assert.equal((await f.get(p)).status, 'ready'); assert.equal(f.calls.length, 0); assert.equal(f.contacts.length, 0);
  f.callSettings.enabled = true; await f.confirm(p);
  f.callSettings.enabled = false; await assert.rejects(f.confirm(p), denied(503)); assert.equal(f.calls.length, 1);
  // A disabled call feature does not prevent a separately selected reminder.
  const reminder = await f.prepare({ kind: 'contact', mode: 'request-only' }); await f.confirm(reminder);
  assert.equal(f.contacts.length, 1); assert.equal(f.calls.length, 1);
});

test('actions: missing or malformed call adapters fail closed and mode changes invalidate prior cards', async t => {
  const f = await fixture(t, { callSupport: true }), p = await f.prepare({ kind: 'contact', mode: 'audio-call' });
  await assert.rejects(f.confirm(p, f.make({ callRequest: undefined })), denied(503));
  await assert.rejects(f.confirm(p, f.make({ callCapabilities: undefined })), denied(503));
  await assert.rejects(f.confirm(p, f.make({ callCapabilities: async () => ({ audioCall: 'true' }) })), denied(503));
  const reminder = await f.prepare({ actionId: p.actionId, version: p.version, kind: 'contact', mode: 'request-only' });
  assert.equal(reminder.version, 2); assert.equal(reminder.audioCall, false);
  assert.equal(reminder.callRequestId, undefined);
  await assert.rejects(f.confirm(p), denied(409)); assert.equal(f.calls.length, 0);
  const audio = await f.prepare({ actionId: p.actionId, version: reminder.version, kind: 'contact', mode: 'audio-call' });
  assert.notEqual(audio.callRequestId, p.callRequestId);
  await assert.rejects(f.confirm(reminder), denied(409)); await f.confirm(audio);
  assert.equal(f.calls.length, 1); assert.equal(f.contacts.length, 0);
});

test('actions: an ambiguous ring creation retries the same request id and returns the same call without a second ring', async t => {
  const f = await fixture(t, { callSupport: true }), p = await f.prepare({ kind: 'contact', mode: 'audio-call' }); let once = true;
  f.hooks.afterCall = () => { if (once) { once = false; throw new Error('call response lost'); } };
  await assert.rejects(f.confirm(p), /call response lost/);
  const failed = await f.get(p); assert.equal(failed.status, 'failed'); assert.match(failed.error, /同一次呼叫/);
  assert.equal(f.effects.size, 1); const result = await f.confirm(p, f.make());
  assert.equal(result.status, 'completed'); assert.equal(f.effects.size, 1); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].requestId, f.calls[1].requestId); assert.equal(f.contacts.length, 0);
});

test('actions: call creation rejects invalid result ids, and failed cancellation never claims a possible ring was hung up', async t => {
  const f = await fixture(t, { callSupport: true }), p = await f.prepare({ kind: 'contact', mode: 'audio-call' });
  await assert.rejects(f.confirm(p, f.make({ callRequest: async () => ({ callId: 'https://unexpected.example/call' }) })), denied(503));
  assert.equal((await f.get(p)).status, 'failed'); assert.equal(f.contacts.length, 0);
  const cancelled = await f.call('aiActionCancel', { actionId: p.actionId, version: p.version });
  assert.equal(cancelled.status, 'cancelled'); assert.match(cancelled.error, /可能已经创建呼叫/); assert.match(cancelled.error, /查看并挂断/);
  await assert.rejects(f.confirm(p), denied(409));
});

test('actions: audio-call confirms retain session/target authorization and the durable concurrent-confirm lease', async t => {
  const f = await fixture(t, { callSupport: true }), p = await f.prepare({ kind: 'contact', mode: 'audio-call' });
  await assert.rejects(f.call('aiActionConfirm', { actionId: p.actionId, version: p.version }, f.second, 'second-token'), denied(404));
  await f.store.mutate(f.target._id, x => ({ ...x, revoked: true })); await assert.rejects(f.confirm(p), denied(404));
  await f.store.mutate(f.target._id, x => ({ ...x, revoked: false }));
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.hooks.beforeCall = async () => { enter(); await gate; };
  const first = f.confirm(p); await entered; await assert.rejects(f.confirm(p, f.make()), denied(409));
  release(); await first; assert.equal(f.calls.length, 1); assert.equal(f.effects.size, 1); assert.equal(f.contacts.length, 0);
});
