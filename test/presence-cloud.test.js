'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server/server');
const { createPresence, MAX_EVENTS } = require('../server/presence');
const { CloudStore } = require('../server/store');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sid = token => 's_' + hash(token);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presence-cloud-'));
  let time = Date.now(); const clock = () => time, logs = [];
  const app = await createApp({ dataDir: dir, setupCode: 'test', presence: { clock, timers: false, log: value => logs.push(value) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function call(action, data = {}, token, status = 200) {
    const response = await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') }, body: JSON.stringify({ action, data }) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  }
  const owner = await call('create', { setupCode: 'test' });
  async function join(role, who = owner) { const invite = await call('invite', { role }, who.token); return call('join', { invite: invite.invite }); }
  const frame = await join('frame');
  async function issue(deviceId = 'living-room-link2', who = owner, device = frame) { return call('presenceSensorIssue', { deviceId, targetFrameId: sid(device.token) }, who.token); }
  const event = (values = {}) => ({ version: 1, eventId: crypto.randomUUID(), source: 'link2-windows', deviceId: 'living-room-link2', type: 'presence.dwell', occurredAt: time, dwellMs: 4200, headCount: 1, ...values });
  return { ...app, dir, base, call, owner, frame, join, issue, event, clock, logs, advance: ms => { time += ms; } };
}

test('HTTPS uploader contract authenticates independently and only delivers to the bound frame', async t => {
  const f = await fixture(t), issued = await f.issue(), event = f.event();
  assert.match(issued.token, /^ps1\./); assert.equal(issued.sensor.targetFrameId, sid(f.frame.token));
  const accepted = await f.call('presenceReport', event, issued.token);
  assert.deepEqual(accepted, { accepted: true, eventId: event.eventId, seq: 1 });
  const presence = (await f.call('state', {}, f.frame.token)).presenceEvent;
  assert.deepEqual(presence, { seq: 1, eventId: event.eventId, type: 'presence.dwell', receivedAt: f.clock(), expiresAt: f.clock() + 15000 });
  const family = await f.join('family'), another = await f.join('frame'), otherOwner = await f.call('create', { setupCode: 'test' }), foreign = await f.join('frame', otherOwner);
  for (const member of [f.owner, family, another, otherOwner, foreign]) assert.equal((await f.call('state', {}, member.token)).presenceEvent, undefined);
  await f.call('state', {}, issued.token, 401);
  for (const token of [f.owner.token, f.frame.token, '', 'test']) await f.call('presenceReport', event, token, 401);
  await f.call('presenceReport', { ...event, deviceId: 'other' }, issued.token, 401);
  const stored = await fs.readFile(path.join(f.dir, 'records.json'), 'utf8');
  assert.ok(!stored.includes(issued.token)); assert.ok(!stored.includes('dwellMs')); assert.ok(!stored.includes('headCount')); assert.ok(!stored.includes('occurredAt'));
  assert.deepEqual(f.logs, [{ status: 'accepted', eventId: event.eventId, seq: 1 }]);
});

test('owner manages bounded sensors, hides digests, and cannot bind another family or a non-frame', async t => {
  const f = await fixture(t), family = await f.join('family'), other = await f.call('create', { setupCode: 'test' }), foreign = await f.join('frame', other);
  for (const member of [family, f.frame]) for (const action of ['presenceSensorList', 'presenceSensorIssue', 'presenceSensorRotate', 'presenceSensorRevoke']) await f.call(action, {}, member.token, 403);
  for (const targetFrameId of [sid(f.owner.token), sid(foreign.token), 's_' + '0'.repeat(64), { $ne: null }]) await f.call('presenceSensorIssue', { deviceId: 'camera', targetFrameId }, f.owner.token, 400);
  for (const deviceId of ['', 'bad space', 'a'.repeat(65), {}, null]) await f.call('presenceSensorIssue', { deviceId, targetFrameId: sid(f.frame.token) }, f.owner.token, 400);
  await f.issue();
  await f.call('presenceSensorIssue', { deviceId: 'living-room-link2', targetFrameId: sid(f.frame.token) }, f.owner.token, 409);
  const listed = await f.call('presenceSensorList', {}, f.owner.token);
  assert.equal(listed.sensors.length, 1); assert.equal(listed.frames.length, 1); assert.equal(listed.sensors[0].active, true);
  assert.ok(!JSON.stringify(listed).includes('digest')); assert.ok(!JSON.stringify(listed).includes('ps1.'));
  await f.call('presenceSensorRotate', { deviceId: 'missing' }, f.owner.token, 404);
  for (let i = 1; i < 8; i++) await f.issue('camera-' + i);
  await f.call('presenceSensorIssue', { deviceId: 'ninth', targetFrameId: sid(f.frame.token) }, f.owner.token, 409);
  await f.call('presenceSensorRevoke', { deviceId: 'living-room-link2' }, f.owner.token);
  assert.equal((await f.issue()).sensor.active, true);
});

test('retries remain idempotent across restart without renewing the 15-second event', async t => {
  const f = await fixture(t), issued = await f.issue(), event = f.event();
  const first = await f.call('presenceReport', event, issued.token);
  const retries = await Promise.all(Array.from({ length: 10 }, () => f.api('presenceReport', event, issued.token)));
  assert.ok(retries.every(item => item.seq === first.seq));
  f.advance(15000);
  assert.equal((await f.call('state', {}, f.frame.token)).presenceEvent, undefined);
  assert.deepEqual(await f.call('presenceReport', event, issued.token), first);
  const restart = await createApp({ dataDir: f.dir, setupCode: 'test', presence: { clock: f.clock, timers: false, log: () => {} } });
  assert.deepEqual(await restart.api('presenceReport', event, issued.token), first);
  assert.equal((await restart.api('state', {}, f.frame.token)).presenceEvent, undefined);
  f.advance(45000);
  await f.call('presenceReport', event, issued.token, 400); // The exact expiry boundary must not recreate it.
  const record = await restart.store.get('presence_' + f.owner.room);
  assert.equal(record.seq, 1);
});

test('strict fields, clock bounds and body limits reject malformed or overlarge events', async t => {
  const f = await fixture(t), issued = await f.issue();
  for (const invalid of [{ version: 2 }, { version: '1' }, { source: 'camera' }, { type: 'gaze' }, { eventId: 'x' }, { headCount: -1 }, { headCount: 11 },
    { headCount: 1.5 }, { dwellMs: -1 }, { dwellMs: 86400001 }, { dwellMs: '4200' }, { occurredAt: null }, { occurredAt: f.clock() - 60000 },
    { occurredAt: f.clock() + 30001 }, { image: 'disallowed' }, { frameId: sid(f.frame.token) }, { family: f.owner.room }]) await f.call('presenceReport', f.event(invalid), issued.token, 400);
  await f.call('presenceReport', f.event({ image: 'x'.repeat(3000) }), issued.token, 413);
  await f.call('presenceReport', f.event({ image: 'x'.repeat(3000) }), f.owner.token, 413);
  let response = await fetch(f.base + '/api', { method: 'POST', headers: { Authorization: 'Bearer ' + issued.token, 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'presenceReport', data: f.event() }) });
  assert.equal(response.status, 400);
  response = await fetch(f.base + '/api', { method: 'POST', headers: { Authorization: 'Bearer ' + issued.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'presenceReport', data: f.event(), image: 'forbidden' }) });
  assert.equal(response.status, 400);
  // SDK's documented 0..10 count is validated without interpreting it as identity or gaze.
  await f.call('presenceReport', f.event({ headCount: 0, dwellMs: 0 }), issued.token);
  await f.call('presenceReport', f.event({ headCount: 10, dwellMs: 86400000 }), issued.token);
});

test('same eventId with changed payload or another sensor cannot overwrite a committed event', async t => {
  const f = await fixture(t), issued = await f.issue(), second = await f.issue('camera-2'), event = f.event();
  await f.call('presenceReport', event, issued.token);
  await f.call('presenceReport', { ...event, dwellMs: 5000 }, issued.token, 409);
  await f.call('presenceReport', { ...event, deviceId: 'camera-2' }, second.token, 409);
  assert.equal((await f.call('state', {}, f.frame.token)).presenceEvent.seq, 1);
  assert.equal((await f.call('presenceReport', f.event({ deviceId: 'camera-2' }), second.token)).seq, 2);
});

test('rotation and revocation immediately invalidate old tokens and already queued events', async t => {
  const f = await fixture(t), issued = await f.issue(), event = f.event();
  await f.call('presenceReport', event, issued.token);
  const rotated = await f.call('presenceSensorRotate', { deviceId: 'living-room-link2' }, f.owner.token);
  assert.notEqual(rotated.token, issued.token);
  await f.call('presenceReport', event, issued.token, 401);
  await f.call('presenceReport', event, rotated.token, 409);
  assert.equal((await f.call('state', {}, f.frame.token)).presenceEvent, undefined);
  await f.call('presenceReport', f.event(), rotated.token);
  await f.call('presenceSensorRevoke', { deviceId: 'living-room-link2' }, f.owner.token);
  await f.call('presenceReport', f.event(), rotated.token, 401);
  assert.equal((await f.call('state', {}, f.frame.token)).presenceEvent, undefined);
  await f.call('presenceSensorRotate', { deviceId: 'living-room-link2' }, f.owner.token, 409);
  assert.equal((await f.call('presenceSensorList', {}, f.owner.token)).sensors[0].active, false);
});

test('revoked, logged-out and expired target sessions stop delivery and uploading', async t => {
  for (const mode of ['revoke', 'logout', 'expire']) {
    const f = await fixture(t), issued = await f.issue(); await f.call('presenceReport', f.event(), issued.token);
    if (mode === 'revoke') await f.call('revoke', { id: sid(f.frame.token) }, f.owner.token);
    if (mode === 'logout') await f.call('logout', {}, f.frame.token);
    if (mode === 'expire') await f.store.mutate(sid(f.frame.token), current => ({ ...current, expires: 1 }));
    await f.call('presenceReport', f.event(), issued.token, 401);
    await f.call('state', {}, f.frame.token, 401);
    assert.equal((await f.call('presenceSensorList', {}, f.owner.token)).sensors[0].targetAvailable, false);
  }
});

test('rotation while report is validating cannot commit with the old sensor generation', async t => {
  const f = await fixture(t), issued = await f.issue();
  const original = f.store.get.bind(f.store); let rotate = true;
  f.store.get = async id => {
    const record = await original(id);
    if (id === sid(f.frame.token) && rotate) { rotate = false; await f.api('presenceSensorRotate', { deviceId: 'living-room-link2' }, f.owner.token); }
    return record;
  };
  await f.call('presenceReport', f.event(), issued.token, 401);
  assert.equal((await f.call('state', {}, f.frame.token)).presenceEvent, undefined);
});

test('sensor revocation after event CAS cannot be acknowledged or surfaced', async t => {
  const f = await fixture(t), issued = await f.issue(), original = f.store.mutate.bind(f.store); let revoke = true;
  f.store.mutate = async (id, change) => {
    const result = await original(id, change);
    if (id === 'presence_' + f.owner.room && result.events.length && revoke) {
      revoke = false; await f.api('presenceSensorRevoke', { deviceId: 'living-room-link2' }, f.owner.token);
    }
    return result;
  };
  await f.call('presenceReport', f.event(), issued.token, 401);
  assert.equal((await f.call('state', {}, f.frame.token)).presenceEvent, undefined);
});

test('cross-instance persistent rate limit allows retries but caps unique events and stored history', async t => {
  const f = await fixture(t), issued = await f.issue(), events = Array.from({ length: 30 }, () => f.event());
  const second = await createApp({ store: f.store, setupCode: 'test', presence: { clock: f.clock, timers: false, log: () => {} } });
  for (let i = 0; i < events.length; i++) await (i % 2 ? second.api : f.api)('presenceReport', events[i], issued.token);
  await assert.rejects(second.api('presenceReport', f.event(), issued.token), { status: 429 });
  assert.equal((await second.api('presenceReport', events[0], issued.token)).seq, 1);
  for (let i = 31; i < 120; i++) await f.api('presenceReport', events[0], issued.token);
  await assert.rejects(second.api('presenceReport', events[0], issued.token), { status: 429 });
  assert.ok((await f.store.get('presence_' + f.owner.room)).events.length <= MAX_EVENTS);
  f.advance(60000);
  assert.equal((await f.call('presenceReport', f.event(), issued.token)).seq, 31);
  const record = await f.store.get('presence_' + f.owner.room);
  assert.equal(record.events.length, 1); assert.equal(record.budgets.length, 2);
});

test('expired fields are scrubbed at 15s and startup removes receipts after their retry horizon', async t => {
  const f = await fixture(t), issued = await f.issue(), event = f.event({ occurredAt: f.clock() + 30000 });
  await f.call('presenceReport', event, issued.token);
  f.advance(15000); await f.call('state', {}, f.frame.token);
  let record = await f.store.get('presence_' + f.owner.room);
  assert.equal(record.events.length, 1); assert.equal(record.events[0].eventId, undefined); assert.equal(record.events[0].targetFrameId, undefined);
  f.advance(75000);
  const restarted = await createApp({ dataDir: f.dir, setupCode: 'test', presence: { clock: f.clock, timers: false, log: () => {} } });
  record = await restarted.store.get('presence_' + f.owner.room);
  assert.deepEqual(record.events, []); assert.deepEqual(record.budgets, []); assert.equal(record.seq, 1); assert.equal(record.sensors.length, 1);
  await assert.rejects(restarted.api('presenceReport', event, issued.token), { status: 400 });
});

// Runs production CloudStore.mutate, with only database transport replaced. Each read yields
// to force optimistic-CAS conflicts; writes atomically compare the revision across two workers.
function cloudTransport(seed) {
  const records = new Map(Object.entries(structuredClone(seed))); let conflicts = 0;
  function worker() {
    const store = Object.create(CloudStore.prototype);
    store.get = async id => { const value = structuredClone(records.get(id) || null); await new Promise(resolve => setImmediate(resolve)); return value; };
    store.db = { command: { exists: () => undefined } };
    store.collection = {
      async add(doc) { if (records.has(doc._id)) throw Error('duplicate'); records.set(doc._id, structuredClone(doc)); return {}; },
      where(query) { return { async update(data) {
        const current = records.get(query._id);
        if (!current || current._rev !== query._rev) { conflicts++; return { updated: 0 }; }
        records.set(query._id, { ...current, ...structuredClone(data) }); return { updated: 1 };
      } }; }
    };
    return store;
  }
  return { worker, conflicts: () => conflicts, records };
}

test('production CloudStore CAS linearizes duplicate reports and family sequence across cloud workers', async t => {
  const f = await fixture(t), issued = await f.issue(), event = f.event();
  const transport = cloudTransport(f.store.records), workers = [transport.worker(), transport.worker()];
  const handlers = workers.map(store => createPresence(store, { clock: f.clock, timers: false, log: () => {} }));
  const duplicates = await Promise.all(Array.from({ length: 8 }, (_, i) => handlers[i % 2].report(event, issued.token)));
  assert.deepEqual(duplicates.map(item => item.seq), Array(8).fill(1));
  const distinct = await Promise.all(Array.from({ length: 12 }, (_, i) => handlers[i % 2].report(f.event(), issued.token)));
  assert.deepEqual(distinct.map(item => item.seq).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 2));
  assert.ok(transport.conflicts() > 0);
  const persisted = transport.records.get('presence_' + f.owner.room);
  assert.equal(persisted.seq, 13); assert.equal(persisted.events.length, 13);
  assert.equal((await handlers[1].snapshot(await workers[1].get(sid(f.frame.token)))).presenceEvent.seq, 13);
});

test('opportunistic cleanup outage cannot prevent startup or unrelated family state reads', async t => {
  const f = await fixture(t), original = f.store.list.bind(f.store); let cleanups = 0;
  f.store.list = async (...args) => { if (args[0] === 'presence') { cleanups++; throw Error('offline cleanup failure'); } return original(...args); };
  const second = await createApp({ store: f.store, setupCode: 'test', presence: { clock: f.clock, timers: false, log: () => {} } });
  assert.equal((await second.api('state', {}, f.owner.token)).room.id, f.owner.room);
  assert.equal(cleanups, 1);
  f.advance(60000);
  assert.equal((await second.api('state', {}, f.owner.token)).room.id, f.owner.room);
  assert.equal(cleanups, 2);
});

let sdk;
try { sdk = require('@cloudbase/node-sdk'); } catch { try { sdk = require('../server/node_modules/@cloudbase/node-sdk'); } catch {} }
test('actual CloudBase SDK serializes whole-array cleanup and revoked digest without nested merge residue', { skip: !sdk }, async () => {
  const query = sdk.init({ env: 'offline-presence-contract' }).database().collection('memory_demo_records').where({ _id: 'presence_offline', _rev: 1 });
  query._request.send = async (action, params) => {
    assert.equal(action, 'database.modifyDocument');
    const update = JSON.parse(params.data).$set;
    assert.deepEqual(update.events, []); assert.deepEqual(update.budgets, []);
    assert.equal(update.sensors[0].digest, null); assert.ok(update.sensors[0].revokedAt);
    assert.deepEqual(Object.keys(update).sort(), ['budgets', 'events', 'sensors']);
    return { data: { updated: 1 }, requestId: 'offline' };
  };
  assert.equal((await query.update({ events: [], budgets: [], sensors: [{ digest: null, revokedAt: 123 }] })).updated, 1);
});
