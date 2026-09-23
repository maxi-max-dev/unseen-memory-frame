'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../server/store');
const { createFamilyContact, PENDING_TTL, ACK_TTL, RETENTION, MAX_ENTRIES } = require('../server/family-contact');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-contact-test-')), store = new LocalStore(dir);
  await store.init(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = 1800000000000;
  async function allowed(s) {
    if (!s.account) return true;
    const account = await store.get(s.account);
    return !!account && account.kind === 'account' && account.status === 'active' && !account.revoked && account.room === s.room && account.role === s.role;
  }
  const contact = createFamilyContact(store, { allowed, clock: () => time });
  async function member(id, options = {}) {
    const doc = { _id: 's_' + id, kind: 'session', name: id, room: 'home', role: 'family', expires: time + 7 * RETENTION, lastSeen: time, ...options };
    await store.put(doc);
    if (doc.account) await store.put({ _id: doc.account, kind: 'account', status: 'active', room: doc.room, role: doc.role });
    return doc;
  }
  const owner = await member('owner', { role: 'owner', account: 'u_owner' }), family = await member('family', { account: 'u_family' });
  const call = (action, data = {}, s = owner) => contact.handle(action, data, s);
  return { dir, store, contact, member, owner, family, call, allowed, clock: () => time, advance: ms => { time += ms; } };
}
const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);
const request = (f, requestId = 'request_001', targetId = 'u_family') => f.call('contactRequest', { targetId, requestId });

test('contact roster uses authorized current family members, deduplicates accounts and reports no real calling', async t => {
  const f = await fixture(t);
  await f.member('family_second', { account: 'u_family', lastSeen: f.clock() - 60000 });
  await f.member('self_second', { account: 'u_owner', role: 'owner' });
  await f.member('frame', { role: 'frame' });
  await f.member('foreign', { room: 'elsewhere' });
  await f.member('expired', { expires: f.clock() });
  await f.member('revoked', { revoked: true });
  await f.member('removed', { account: 'u_removed' });
  await f.store.mutate('u_removed', old => ({ ...old, revoked: true }));
  const state = await f.call('contactState');
  assert.deepEqual(state.members.map(x => x.id).sort(), ['s_frame', 'u_family']);
  assert.equal(state.members.find(x => x.id === 'u_family').recentlySeen, true);
  assert.equal(state.audioCall, false); assert.equal(state.backgroundPush, false); assert.equal(state.mode, 'request-only');
  assert.deepEqual(state.requests, []); assert.equal(state.incomingCount, 0);
  assert.equal(await f.store.get('fc_home'), null, 'empty polling does not allocate/write a contact record');
});

test('contact request, recipient acknowledgement and either-party end form a persisted two-sided loop', async t => {
  const f = await fixture(t), sent = await request(f), id = sent.requests[0].id;
  assert.equal(sent.requests[0].status, 'pending'); assert.equal(sent.requests[0].direction, 'outgoing');
  assert.equal(sent.requests[0].expiresAt, f.clock() + PENDING_TTL);
  assert.equal('requestKey' in sent.requests[0], false);
  const incoming = await f.call('contactState', {}, f.family);
  assert.equal(incoming.incomingCount, 1); assert.equal(incoming.requests[0].direction, 'incoming');
  await rejects(f.call('contactRespond', { id, response: 'acknowledge' }), 403);
  const ack = await f.call('contactRespond', { id, response: 'acknowledge' }, f.family);
  assert.equal(ack.requests[0].status, 'acknowledged'); assert.equal(ack.incomingCount, 0);
  assert.equal(ack.requests[0].expiresAt, f.clock() + ACK_TTL);
  const reloadedStore = new LocalStore(f.dir); await reloadedStore.init();
  const reloaded = createFamilyContact(reloadedStore, { allowed: f.allowed, clock: f.clock });
  assert.equal((await reloaded.handle('contactState', {}, f.owner)).requests[0].status, 'acknowledged');
  assert.equal((await f.call('contactEnd', { id }, f.family)).requests[0].status, 'ended');
  assert.equal((await f.call('contactEnd', { id })).requests[0].status, 'ended');
  await rejects(f.call('contactRespond', { id, response: 'acknowledge' }, f.family), 409);
});

test('recipient decline and caller cancel are distinct, idempotent terminal states', async t => {
  const f = await fixture(t), id = (await request(f)).requests[0].id;
  await rejects(f.call('contactEnd', { id }, f.family), 403);
  assert.equal((await f.call('contactRespond', { id, response: 'decline' }, f.family)).requests[0].status, 'declined');
  assert.equal((await f.call('contactRespond', { id, response: 'decline' }, f.family)).requests[0].status, 'declined');
  const second = (await request(f, 'request_002')).requests.find(x => x.status === 'pending');
  assert.equal((await f.call('contactEnd', { id: second.id })).requests.find(x => x.id === second.id).status, 'cancelled');
});

test('request bodies cannot forge sender/room/target, cross family state or respond as a third member', async t => {
  const f = await fixture(t), outsider = await f.member('outsider', { room: 'elsewhere' }), third = await f.member('third');
  for (const data of [null, [], 'x']) await rejects(f.call('contactRequest', data), 400);
  for (const targetId of [null, {}, 'u_owner', 'https://example.com']) await rejects(request(f, 'request_001', targetId), 400);
  await rejects(request(f, 'request_001', outsider._id), 404);
  const result = await f.call('contactRequest', { targetId: 'u_family', requestId: 'request_001', room: 'elsewhere', from: outsider._id, expiresAt: Infinity });
  const id = result.requests[0].id;
  assert.equal(result.requests[0].from.id, 'u_owner'); assert.equal(result.requests[0].expiresAt, f.clock() + PENDING_TTL);
  assert.deepEqual((await f.call('contactState', {}, third)).requests, []);
  await rejects(f.call('contactRespond', { id, response: 'acknowledge' }, third), 404);
  await rejects(f.call('contactEnd', { id }, outsider), 404);
  await rejects(f.call('contactRespond', { id, response: 'connected' }, f.family), 400);
  await rejects(f.call('contactState', {}, { ...f.owner, room: 'elsewhere' }), 401);
});

test('every action rechecks expired or removed sessions and accounts; removing a target invalidates active requests', async t => {
  const f = await fixture(t), id = (await request(f)).requests[0].id;
  await f.store.mutate('u_family', old => ({ ...old, revoked: true }));
  await rejects(request(f, 'request_002'), 404);
  for (const action of ['contactState', 'contactRespond', 'contactEnd', 'contactRequest']) await rejects(f.call(action, { id, response: 'acknowledge', targetId: 'u_owner', requestId: 'new_request' }, f.family), 401);
  const state = await f.call('contactState');
  assert.equal(state.requests[0].status, 'unavailable'); assert.equal(state.members.length, 0);
  await f.store.mutate(f.owner._id, old => ({ ...old, expires: f.clock() }));
  await rejects(f.call('contactState'), 401);
});

test('a request survives account relogin but only an active same-account session can acknowledge it', async t => {
  const f = await fixture(t), id = (await request(f)).requests[0].id;
  await f.store.mutate(f.family._id, old => ({ ...old, revoked: true }));
  const newSession = await f.member('family_new', { account: 'u_family' });
  await rejects(f.call('contactRespond', { id, response: 'acknowledge' }, f.family), 401);
  assert.equal((await f.call('contactRespond', { id, response: 'acknowledge' }, newSession)).requests[0].status, 'acknowledged');
});

test('ordinary logout and an intervening sender poll preserve pending reminders for a registered account', async t => {
  const f = await fixture(t), id = (await request(f)).requests[0].id;
  await f.store.mutate(f.family._id, old => ({ ...old, revoked: true }));
  const offline = await f.call('contactState');
  assert.equal(offline.requests[0].status, 'pending');
  assert.equal(offline.members.find(member => member.id === 'u_family').recentlySeen, false);
  assert.equal((await f.store.get('fc_home')).entries[0].status, 'pending');
  const relogin = await f.member('family_relogin', { account: 'u_family' });
  assert.equal((await f.call('contactRespond', { id, response: 'acknowledge' }, relogin)).requests[0].status, 'acknowledged');
});

test('an older roster snapshot cannot permanently invalidate a contact created by a newly joined member', async t => {
  const f = await fixture(t), read = f.store.get.bind(f.store);
  let reached, resume;
  const paused = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
  let intercepted = false;
  f.store.get = async id => {
    if (id === 'fc_home' && !intercepted) { intercepted = true; reached(); await release; }
    return read(id);
  };
  const oldPoll = f.call('contactState'); await paused;
  const joined = await f.member('joined');
  const sent = await f.call('contactRequest', { targetId: 'u_owner', requestId: 'request_new_member' }, joined);
  resume(); await oldPoll;
  const stored = await read('fc_home'); assert.equal(stored.entries[0].status, 'pending');
  const fresh = await f.call('contactState'); assert.equal(fresh.requests.find(item => item.id === sent.requests[0].id).status, 'pending');
  assert.equal((await f.call('contactRespond', { id: sent.requests[0].id, response: 'acknowledge' })).requests[0].status, 'acknowledged');
});

test('concurrent retries share one request and one rate charge; opposite-direction duplicates are rejected', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => request(f)));
  assert.equal(new Set(results.map(x => x.requests[0].id)).size, 1);
  const doc = await f.store.get('fc_home'); assert.equal(doc.entries.length, 1); assert.equal(doc.budget.count, 1);
  await rejects(request(f, 'request_002'), 409);
  await rejects(f.call('contactRequest', { targetId: 'u_owner', requestId: 'request_002' }, f.family), 409);
  const third = await f.member('third');
  await rejects(request(f, 'request_001', third._id), 409);
});

test('durable sender and room budgets survive cancellations and module restarts', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 6; n++) {
    const id = (await request(f, 'request_' + n)).requests.find(x => x.status === 'pending').id;
    await f.call('contactEnd', { id });
  }
  const restarted = createFamilyContact(f.store, { allowed: f.allowed, clock: f.clock });
  await rejects(restarted.handle('contactRequest', { targetId: 'u_family', requestId: 'request_007' }, f.owner), 429);
  f.advance(10 * 60000);
  await request(f, 'request_008');
  await f.store.mutate('fc_home', old => ({ ...old, budget: { since: f.clock(), count: 30, senders: {} } }));
  const third = await f.member('third'); await rejects(request(f, 'request_009', third._id), 429);
});

test('server clock expires pending and acknowledged requests without trusting client timers', async t => {
  const f = await fixture(t), id = (await request(f)).requests[0].id;
  f.advance(PENDING_TTL);
  await rejects(f.call('contactRespond', { id, response: 'acknowledge' }, f.family), 409);
  assert.equal((await f.call('contactState')).requests[0].status, 'expired');
  const next = (await request(f, 'request_002')).requests.find(x => x.status === 'pending');
  await f.call('contactRespond', { id: next.id, response: 'acknowledge' }, f.family);
  f.advance(ACK_TTL);
  assert.equal((await f.call('contactState')).requests.find(x => x.id === next.id).status, 'expired');
  f.advance(RETENTION);
  assert.equal((await f.call('contactState')).requests.length, 0);
  assert.equal((await f.store.get('fc_home')).entries.length, 0);
});

test('contact history stays bounded and limits simultaneous outgoing requests', async t => {
  const f = await fixture(t);
  for (let n = 0; n < MAX_ENTRIES + 3; n++) {
    f.advance(1000);
    const id = (await request(f, 'request_' + n)).requests.find(x => x.status === 'pending').id;
    await f.call('contactEnd', { id });
    if (n % 6 === 5) f.advance(10 * 60000);
  }
  assert.equal((await f.store.get('fc_home')).entries.length, MAX_ENTRIES);
  f.advance(10 * 60000);
  for (let n = 0; n < 3; n++) { const member = await f.member('other_' + n); await request(f, 'parallel_' + n, member._id); }
  const fourth = await f.member('fourth'); await rejects(request(f, 'parallel_4', fourth._id), 429);
});
