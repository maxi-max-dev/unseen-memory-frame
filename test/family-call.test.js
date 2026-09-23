'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalStore, CloudStore } = require('../server/store');
const { createFamilyCall, RING_TTL, CALL_TTL, PEER_TTL, RETENTION, MAX_CANDIDATES, MAX_SDP_BYTES, MAX_HISTORY } = require('../server/family-call');

const testEnv = () => ({ MEMORY_CALL_ENABLED: '1', MEMORY_CALL_ICE_SERVERS_JSON: JSON.stringify([{ urls: 'turns:relay.example.test:5349?transport=tcp' }]), MEMORY_CALL_TURN_SECRET: 'local-unit-test-only-not-a-real-key-123456' });
const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' };
const answer = { ...offer, type: 'answer' };
const candidate = (n = 1) => ({ candidate: `candidate:${n} 1 udp 1 203.0.113.10 ${40000 + n} typ relay raddr 0.0.0.0 rport 0`, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'test' });
const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);

async function fixture(t, customEnv = testEnv()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-call-test-')), store = new LocalStore(dir);
  await store.init(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = 1800000000000;
  async function allowed(s) {
    if (!s.account) return true;
    const a = await store.get(s.account);
    return !!a && a.kind === 'account' && a.status === 'active' && !a.revoked && a.room === s.room && a.role === s.role;
  }
  async function member(id, options = {}) {
    const s = { _id: 's_' + id, kind: 'session', room: 'home', name: id, role: 'family', lastSeen: time, expires: time + 7 * RETENTION, ...options };
    await store.put(s);
    if (s.account && !await store.get(s.account)) await store.put({ _id: s.account, kind: 'account', room: s.room, role: s.role, status: 'active' });
    return s;
  }
  const owner = await member('owner', { account: 'u_owner', role: 'owner' }), family = await member('family', { account: 'u_family' });
  const service = createFamilyCall(store, { allowed, env: customEnv, clock: () => time });
  const call = (action, data = {}, s = owner) => service.handle(action, data, s);
  const start = (requestId = 'request_001', targetId = 'u_family', s = owner) => call('callStart', { requestId, targetId }, s);
  return { store, service, call, member, owner, family, start, env: customEnv, allowed, clock: () => time, advance: ms => { time += ms; } };
}

async function accepted(f) {
  const { callId: id } = await f.start();
  await f.call('callAccept', { id }, f.family); return id;
}

test('voice calling is disabled by default and capabilities never disclose ICE configuration or secret', async t => {
  const f = await fixture(t, {}), capabilities = await f.call('callCapabilities');
  assert.equal(capabilities.enabled, false); assert.equal(capabilities.audioCall, false);
  assert.equal(capabilities.iceTransportPolicy, 'relay'); assert.match(capabilities.reason, /尚未启用/);
  assert.equal('iceServers' in capabilities, false); assert.equal('secret' in capabilities, false);
  assert.deepEqual((await f.call('callState')).calls, []);
  await rejects(f.start(), 503); assert.equal(await f.store.get('rtc_home'), null);
  await rejects(f.call('callCapabilities', {}, { ...f.owner, _id: 's_missing' }), 401);
});

test('missing TURN, malformed addresses, inline credentials and invalid secret keep the capability closed', async t => {
  const f = await fixture(t);
  const configs = [undefined, 'not JSON', '{}', '[]', JSON.stringify([{ urls: 'stun:stun.example.test:3478' }]),
    JSON.stringify([{ urls: 'https://example.test' }]), JSON.stringify([{ urls: 'turn:user:pass@relay.example.test' }]),
    JSON.stringify([{ urls: 'turn:relay.example.test:70000' }]), JSON.stringify([{ urls: 'turn:relay.example.test', username: 'u', credential: 'password' }])];
  for (const config of configs) {
    f.env.MEMORY_CALL_ICE_SERVERS_JSON = config;
    assert.equal((await f.call('callCapabilities')).enabled, false); await rejects(f.start(), 503);
  }
  f.env.MEMORY_CALL_ICE_SERVERS_JSON = testEnv().MEMORY_CALL_ICE_SERVERS_JSON; f.env.MEMORY_CALL_TURN_SECRET = 'short';
  assert.equal((await f.call('callCapabilities')).enabled, false);
});

test('calls target only current authorized family members and public listings contain metadata only', async t => {
  const f = await fixture(t), third = await f.member('third'), other = await f.member('other', { room: 'elsewhere' });
  const old = await f.member('old', { expires: f.clock() });
  await rejects(f.start('request_001', other._id), 404); await rejects(f.start('request_001', old._id), 404);
  await rejects(f.start('request_001', 'u_owner'), 400);
  const result = await f.start(); assert.equal(result.call.status, 'ringing'); assert.equal(result.call.canControl, true);
  assert.equal(result.call.expiresAt, f.clock() + RING_TTL); assert.equal('callerSession' in result.call, false); assert.equal('peer' in result.call, false);
  const incoming = (await f.call('callState', {}, f.family)).calls[0];
  assert.equal(incoming.direction, 'incoming'); assert.equal(incoming.canControl, false);
  assert.deepEqual((await f.call('callState', {}, third)).calls, []);
  for (const action of ['callState', 'callIce', 'callAccept', 'callSignal', 'callEnd']) {
    await rejects(f.call(action, { id: result.callId, description: offer }, third), 404);
  }
  await rejects(f.call('callState', { id: result.callId }, other), 404);
});

test('concurrent start retries use one persisted call while crossed calls and busy members are rejected', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.start()));
  assert.equal(new Set(results.map(item => item.callId)).size, 1);
  const record = await f.store.get('rtc_home'); assert.equal(record.calls.length, 1); assert.equal(record.starts.length, 1); assert.equal(record.budget.count, 1);
  await rejects(f.start('another_request'), 409);
  await rejects(f.start('reverse_request', 'u_owner', f.family), 409);
  const third = await f.member('third'); await rejects(f.start('third_request', 'u_family', third), 409);
  await rejects(f.start('request_001', third._id), 409);
});

test('cancelling a pending start persists a tombstone before a delayed create CAS can ring', async t => {
  const f = await fixture(t), mutate = f.store.mutate.bind(f.store);
  let reached, resume, pausedOnce = false;
  const paused = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
  f.store.mutate = async (id, change) => {
    if (id === 'rtc_home' && !pausedOnce) { pausedOnce = true; reached(); await release; }
    return mutate(id, change);
  };
  const pending = f.start(); await paused;
  const cancelled = await f.call('callCancelStart', { requestId: 'request_001' });
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.callId, null);
  resume(); await rejects(pending, 409);
  await rejects(f.start(), 409);
  await f.call('callCancelStart', { requestId: 'request_001' });
  const record = await f.store.get('rtc_home'); assert.equal(record.calls.length, 0); assert.equal(record.starts.length, 1);
  assert.equal(record.starts[0].cancelled, true); assert.equal(record.budget.count, 1);
});

test('a lost start response can be cancelled by request ID, only on its original device', async t => {
  const f = await fixture(t), sibling = await f.member('owner_sibling', { account: 'u_owner', role: 'owner' });
  await f.start(); // The caller deliberately does not need the returned call ID.
  await rejects(f.call('callCancelStart', { requestId: 'request_001' }, sibling), 403);
  const cancelled = await f.call('callCancelStart', { requestId: 'request_001' });
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.call.status, 'ended'); assert.equal(cancelled.call.reason, 'cancelled');
  await rejects(f.start(), 409);
  f.env.MEMORY_CALL_ENABLED = '0';
  assert.equal((await f.call('callCancelStart', { requestId: 'request_001' })).cancelled, true);
  const record = await f.store.get('rtc_home'); assert.equal('signals' in record.calls[0], false); assert.equal(record.budget.count, 1);
});

test('new cancellation tombstones are quota bounded, while existing cancellation retries remain available', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 4; n++) await f.call('callCancelStart', { requestId: 'cancelled_' + n });
  await rejects(f.call('callCancelStart', { requestId: 'cancelled_5' }), 429);
  await f.call('callCancelStart', { requestId: 'cancelled_0' });
  const foreign = await f.member('foreign', { room: 'elsewhere' });
  await f.call('callCancelStart', { requestId: 'cancelled_0' }, foreign);
  assert.equal((await f.store.get('rtc_home')).starts.length, 4); assert.equal((await f.store.get('rtc_elsewhere')).starts.length, 1);
});

test('accept is recipient-only and atomically binds one answering device; sibling sessions never get SDP or credentials', async t => {
  const f = await fixture(t), second = await f.member('family_second', { account: 'u_family' }), callerSecond = await f.member('owner_second', { account: 'u_owner', role: 'owner' });
  const { callId: id } = await f.start(); await rejects(f.call('callAccept', { id }), 403);
  await rejects(f.call('callIce', { id }), 409);
  const choices = await Promise.allSettled([f.call('callAccept', { id }, f.family), f.call('callAccept', { id }, second)]);
  assert.equal(choices.filter(item => item.status === 'fulfilled').length, 1); assert.equal(choices.filter(item => item.status === 'rejected' && item.reason.status === 409).length, 1);
  const winner = choices[0].status === 'fulfilled' ? f.family : second, loser = winner === f.family ? second : f.family;
  assert.equal((await f.call('callAccept', { id }, winner)).call.status, 'accepted');
  await f.call('callSignal', { id, description: offer });
  assert.equal((await f.call('callState', { id }, winner)).call.peer.description.type, 'offer');
  for (const sibling of [loser, callerSecond]) {
    const state = await f.call('callState', { id }, sibling); assert.equal(state.call.canControl, false); assert.equal('peer' in state.call, false);
    await rejects(f.call('callIce', { id }, sibling), 403); await rejects(f.call('callSignal', { id, description: answer }, sibling), 403);
    await rejects(f.call('callEnd', { id }, sibling), 403);
  }
});

test('reject winning the CAS before a delayed accept prevents the call from becoming accepted', async t => {
  const f = await fixture(t), { callId: id } = await f.start(), mutate = f.store.mutate.bind(f.store);
  let reached, resume, pausedOnce = false;
  const paused = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
  f.store.mutate = async (docId, change) => {
    if (docId === 'rtc_home' && !pausedOnce) { pausedOnce = true; reached(); await release; }
    return mutate(docId, change);
  };
  const accepting = f.call('callAccept', { id }, f.family); await paused;
  assert.equal((await f.call('callReject', { id }, f.family)).call.status, 'declined');
  resume(); await rejects(accepting, 409);
  const stored = (await f.store.get('rtc_home')).calls.find(item => item.id === id);
  assert.equal(stored.status, 'declined'); assert.equal(stored.calleeSession, null);
  assert.equal('signals' in stored, false); assert.equal('heartbeat' in stored, false);
});

test('a stale ringing reject ends the exact accepting device after its accept response is lost', async t => {
  const f = await fixture(t), { callId: id } = await f.start();
  await f.call('callAccept', { id }, f.family); // Simulate discarding the successful response.
  const ended = await f.call('callReject', { id }, f.family);
  assert.equal(ended.call.status, 'ended'); assert.equal(ended.call.reason, 'cancelled');
  const retry = await f.call('callReject', { id }, f.family);
  assert.equal(retry.call.status, 'ended'); assert.equal(retry.call.revision, ended.call.revision);
  const stored = (await f.store.get('rtc_home')).calls.find(item => item.id === id);
  assert.equal('signals' in stored, false); assert.equal('heartbeat' in stored, false);
  await rejects(f.call('callIce', { id }, f.family), 409);
});

test('reject with an older ringing snapshot ends only its own newly accepted and connecting device', async t => {
  const f = await fixture(t), sibling = await f.member('family_sibling', { account: 'u_family' });
  const { callId: id } = await f.start(), mutate = f.store.mutate.bind(f.store);
  let reached, resume, pausedOnce = false;
  const paused = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
  f.store.mutate = async (docId, change) => {
    if (docId === 'rtc_home' && !pausedOnce) { pausedOnce = true; reached(); await release; }
    return mutate(docId, change);
  };
  const rejecting = f.call('callReject', { id }, f.family); await paused;
  await f.call('callAccept', { id }, f.family);
  await rejects(f.call('callReject', { id }, sibling), 409);
  assert.equal((await f.call('callState', { id })).call.status, 'accepted');
  await f.call('callSignal', { id, description: offer, candidates: [candidate()] });
  await rejects(f.call('callReject', { id }, sibling), 409);
  assert.equal((await f.call('callState', { id })).call.status, 'connecting');
  resume(); assert.equal((await rejecting).call.status, 'ended');
  const stored = (await f.store.get('rtc_home')).calls.find(item => item.id === id);
  assert.equal(stored.reason, 'cancelled'); assert.equal('signals' in stored, false); assert.equal('heartbeat' in stored, false);
  await rejects(f.call('callReject', { id }, sibling), 409);
});

test('the bound answering device can finish retrying reject after failure or expiry without changing the terminal result', async t => {
  const f = await fixture(t), sibling = await f.member('family_sibling', { account: 'u_family' });
  for (const [status, delay] of [['failed', PEER_TTL + 1], ['expired', CALL_TTL]]) {
    const { callId: id } = await f.start('request_' + status);
    await f.call('callAccept', { id }, f.family); f.advance(delay);
    const terminal = await f.call('callReject', { id }, f.family);
    assert.equal(terminal.call.status, status);
    const retry = await f.call('callReject', { id }, f.family);
    assert.equal(retry.call.status, status); assert.equal(retry.call.revision, terminal.call.revision);
    await rejects(f.call('callReject', { id }, sibling), 409);
  }
});

test('authenticated accepted endpoints receive bounded coturn REST credentials without exposing the shared secret', async t => {
  const f = await fixture(t), id = await accepted(f);
  const a = await f.call('callIce', { id }), b = await f.call('callIce', { id }, f.family);
  assert.equal(a.iceTransportPolicy, 'relay'); assert.equal(a.expiresAt, f.clock() + CALL_TTL + 60000);
  const server = a.iceServers[0]; assert.match(server.username, /^\d+:[a-f0-9]{24}$/);
  assert.equal(server.credential, crypto.createHmac('sha1', f.env.MEMORY_CALL_TURN_SECRET).update(server.username).digest('base64'));
  assert.notEqual(a.iceServers[0].username, b.iceServers[0].username);
  assert.equal(JSON.stringify(a).includes(f.env.MEMORY_CALL_TURN_SECRET), false);
  const raw = JSON.stringify(await f.store.get('rtc_home')); assert.equal(raw.includes(server.credential), false); assert.equal(raw.includes(f.env.MEMORY_CALL_TURN_SECRET), false);
  assert.equal('iceServers' in (await f.call('callCapabilities')), false);
});

test('offer/answer and trickled relay candidates cross only to the bound peer with monotonic deduplicated sequences', async t => {
  const f = await fixture(t), id = await accepted(f);
  await rejects(f.call('callSignal', { id, description: answer }, f.family), 409);
  await rejects(f.call('callSignal', { id, description: answer }), 403);
  await f.call('callSignal', { id, description: offer, candidates: [candidate(1), candidate(2)] });
  const duplicate = await f.call('callSignal', { id, description: offer, candidates: [candidate(1)] });
  assert.equal(duplicate.call.status, 'connecting'); const revision = duplicate.call.revision;
  assert.equal((await f.call('callSignal', { id, description: offer })).call.revision, revision);
  const incoming = (await f.call('callState', { id }, f.family)).call;
  assert.deepEqual(incoming.peer.description, offer); assert.deepEqual(incoming.peer.candidates.map(item => item.seq), [1, 2]);
  await f.call('callSignal', { id, description: answer, candidates: [candidate(3)], iceComplete: true }, f.family);
  const outgoing = (await f.call('callState', { id })).call;
  assert.deepEqual(outgoing.peer.description, answer); assert.equal(outgoing.peer.iceComplete, true);
  assert.equal(outgoing.peer.candidates[0].candidate.candidate, candidate(3).candidate);
  assert.equal('peer' in (await f.call('callState')).calls[0], false);
  assert.notEqual(outgoing.status, 'connected');
});

test('SDP is immutable, audio-only and bounded; ICE batches and total candidate counts are bounded', async t => {
  const f = await fixture(t), id = await accepted(f);
  for (const description of [{ type: 'rollback', sdp: offer.sdp }, { ...offer, sdp: offer.sdp.replace('m=audio', 'm=video') },
    { ...offer, sdp: offer.sdp + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }, { ...offer, sdp: offer.sdp + 'x'.repeat(MAX_SDP_BYTES) }]) await rejects(f.call('callSignal', { id, description }), 400);
  await f.call('callSignal', { id, description: offer });
  await rejects(f.call('callSignal', { id, description: { ...offer, sdp: offer.sdp + 'a=changed\r\n' } }), 409);
  await rejects(f.call('callSignal', { id, candidates: Array.from({ length: 9 }, (_, n) => candidate(n)) }), 400);
  await rejects(f.call('callSignal', { id, candidates: [{ ...candidate(), candidate: candidate().candidate.replace('typ relay', 'typ host') }] }), 400);
  await rejects(f.call('callSignal', { id, candidates: [{ ...candidate(), candidate: 'candidate:' + 'x'.repeat(1024) }] }), 400);
  await rejects(f.call('callSignal', { id, candidates: [{ ...candidate(), sdpMid: null, sdpMLineIndex: null }] }), 400);
  for (let n = 0; n < MAX_CANDIDATES; n += 8) await f.call('callSignal', { id, candidates: Array.from({ length: 8 }, (_, offset) => candidate(n + offset)) });
  await rejects(f.call('callSignal', { id, candidates: [candidate(100)] }), 429);
  assert.equal((await f.call('callState', { id }, f.family)).call.peer.candidates.length, MAX_CANDIDATES);
});

test('ICE completion can be retried but prevents new candidates', async t => {
  const f = await fixture(t), id = await accepted(f);
  await f.call('callSignal', { id, candidates: [candidate()], iceComplete: true });
  const first = await f.call('callSignal', { id, candidates: [candidate()], iceComplete: true });
  const second = await f.call('callSignal', { id, iceComplete: true }); assert.equal(second.call.revision, first.call.revision);
  await rejects(f.call('callSignal', { id, candidates: [candidate(2)] }), 409);
});

test('inline SDP candidates obey relay parsing and share the trickle candidate budget without duplicates', async t => {
  const f = await fixture(t), id = await accepted(f);
  const host = candidate().candidate.replace('203.0.113.10', '192.168.1.43').replace('typ relay', 'typ host');
  await rejects(f.call('callSignal', { id, description: { ...offer, sdp: offer.sdp + 'a=' + host + '\r\n' } }), 400);
  await rejects(f.call('callSignal', { id, candidates: [{ ...candidate(), candidate: host + ' typ relay' }] }), 400);
  const embedded = { ...offer, sdp: offer.sdp + 'a=mid:0\r\na=ice-ufrag:test\r\na=' + candidate().candidate + '\r\n' };
  await f.call('callSignal', { id, description: embedded, candidates: [candidate()] });
  const peer = (await f.call('callState', { id }, f.family)).call.peer;
  assert.equal(peer.candidates.length, 1); assert.doesNotMatch(peer.description.sdp, /a=candidate:/);
  for (let n = 2; n <= MAX_CANDIDATES; n += 8) await f.call('callSignal', { id, candidates: Array.from({ length: Math.min(8, MAX_CANDIDATES - n + 1) }, (_, offset) => candidate(n + offset)) });
  await rejects(f.call('callSignal', { id, candidates: [candidate(100)] }), 429);
  assert.equal((await f.call('callState', { id }, f.family)).call.peer.candidates.length, MAX_CANDIDATES);
});

test('SDP cannot embed more candidates than the shared per-device limit', async t => {
  const f = await fixture(t), id = await accepted(f);
  const sdp = offer.sdp + Array.from({ length: MAX_CANDIDATES + 1 }, (_, n) => 'a=' + candidate(n).candidate + '\r\n').join('');
  await rejects(f.call('callSignal', { id, description: { ...offer, sdp } }), 429);
  assert.equal((await f.call('callState', { id }, f.family)).call.peer.candidates.length, 0);
});

test('decline, cancel, failure and hangup are real terminal states and erase all stored SDP/ICE', async t => {
  const f = await fixture(t), one = await f.start();
  await rejects(f.call('callReject', { id: one.callId }), 403);
  await rejects(f.call('callEnd', { id: one.callId }, f.family), 403);
  assert.equal((await f.call('callReject', { id: one.callId }, f.family)).call.status, 'declined');
  assert.equal((await f.call('callReject', { id: one.callId }, f.family)).call.status, 'declined');
  const two = await f.start('request_002'); assert.equal((await f.call('callEnd', { id: two.callId, reason: 'cancelled' })).call.reason, 'cancelled');
  const three = await f.start('request_003'); await f.call('callAccept', { id: three.callId }, f.family);
  await f.call('callSignal', { id: three.callId, description: offer, candidates: [candidate()] });
  const ended = await f.call('callEnd', { id: three.callId, reason: 'failed' }, f.family);
  assert.equal(ended.call.status, 'failed'); assert.equal('peer' in ended.call, false);
  const stored = (await f.store.get('rtc_home')).calls.find(item => item.id === three.callId);
  assert.equal('signals' in stored, false); assert.equal('heartbeat' in stored, false);
  assert.equal((await f.call('callEnd', { id: three.callId })).call.status, 'failed');
  await rejects(f.call('callSignal', { id: three.callId, description: offer }), 409); await rejects(f.call('callIce', { id: three.callId }), 409);
});

test('revocation and per-device logout revoke control immediately and fail the peer call on its next state read', async t => {
  const f = await fixture(t), id = await accepted(f);
  await f.member('family_second', { account: 'u_family' });
  await f.call('callSignal', { id, description: offer });
  await f.store.mutate(f.family._id, old => ({ ...old, revoked: true }));
  for (const action of ['callCapabilities', 'callState', 'callAccept', 'callReject', 'callEnd', 'callIce', 'callSignal', 'callStart']) {
    await rejects(f.call(action, { id, targetId: 'u_owner', requestId: 'new_request', description: answer }, f.family), 401);
  }
  const state = await f.call('callState', { id });
  assert.equal(state.call.status, 'failed'); assert.equal(state.call.reason, 'permission-revoked'); assert.equal('peer' in state.call, false);
  await f.store.mutate('u_family', old => ({ ...old, revoked: true }));
  await rejects(f.start('request_002'), 404);
});

test('a state request with an older roster cannot revoke a call just created by a new member', async t => {
  const f = await fixture(t), read = f.store.get.bind(f.store);
  let reached, resume, pausedOnce = false;
  const paused = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
  f.store.get = async id => {
    if (id === 'rtc_home' && !pausedOnce) { pausedOnce = true; reached(); await release; }
    return read(id);
  };
  const pending = f.call('callState'); await paused;
  const newcomer = await f.member('newcomer'), started = await f.start('new_call_request', 'u_owner', newcomer);
  resume(); await pending;
  const latest = (await f.call('callState', { id: started.callId })).call;
  assert.equal(latest.status, 'ringing');
  assert.equal((await read('rtc_home')).calls[0].status, 'ringing');
  assert.equal((await f.call('callAccept', { id: started.callId })).call.status, 'accepted');
});

test('a state request with an older roster cannot revoke a new valid answering device', async t => {
  const f = await fixture(t), started = await f.start(), read = f.store.get.bind(f.store);
  let reached, resume, pausedOnce = false;
  const paused = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
  f.store.get = async id => {
    if (id === 'rtc_home' && !pausedOnce) { pausedOnce = true; reached(); await release; }
    return read(id);
  };
  const pending = f.call('callState', { id: started.callId }); await paused;
  const newDevice = await f.member('new_answering_device', { account: 'u_family' });
  await f.call('callAccept', { id: started.callId }, newDevice); resume();
  assert.equal((await pending).call.status, 'accepted');
  assert.equal((await f.call('callState', { id: started.callId }, newDevice)).call.canControl, true);
  assert.equal((await f.call('callIce', { id: started.callId }, newDevice)).iceTransportPolicy, 'relay');
});

test('a pending expiry cleanup cannot end a newly created call during its CAS retry', async t => {
  const f = await fixture(t), previous = await f.start(); f.advance(RING_TTL);
  const mutate = f.store.mutate.bind(f.store); let reached, resume, pausedOnce = false;
  const paused = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
  f.store.mutate = async (id, change) => {
    if (id === 'rtc_home' && !pausedOnce) { pausedOnce = true; reached(); await release; }
    return mutate(id, change);
  };
  const pending = f.call('callState', { id: previous.callId }); await paused;
  const newcomer = await f.member('newcomer'), started = await f.start('new_call_request', 'u_owner', newcomer);
  resume(); await pending;
  const record = await f.store.get('rtc_home');
  assert.equal(record.calls.find(item => item.id === started.callId).status, 'ringing');
  assert.equal(record.calls.find(item => item.id === previous.callId).status, 'expired');
});

test('ringing, missing heartbeat and hard call limit expire on server time, and no heartbeat extends the call limit', async t => {
  const f = await fixture(t), first = await f.start(); f.advance(RING_TTL);
  await rejects(f.call('callAccept', { id: first.callId }, f.family), 409);
  assert.equal((await f.call('callState', { id: first.callId })).call.status, 'expired');
  const second = await f.start('request_002'); await f.call('callAccept', { id: second.callId }, f.family);
  f.advance(PEER_TTL + 1);
  const missing = (await f.call('callState', { id: second.callId })).call; assert.equal(missing.status, 'failed'); assert.equal(missing.reason, 'peer-left');
  const third = await f.start('request_003'); const accepting = await f.call('callAccept', { id: third.callId }, f.family);
  const deadline = accepting.call.expiresAt;
  for (let elapsed = 0; elapsed < CALL_TTL; elapsed += 30000) {
    f.advance(30000); await f.call('callState', { id: third.callId }); await f.call('callState', { id: third.callId }, f.family);
  }
  const final = (await f.call('callState', { id: third.callId })).call;
  assert.equal(final.status, 'expired'); assert.equal(final.expiresAt, deadline);
});

test('disabling the service ends calls without returning fresh ICE credentials', async t => {
  const f = await fixture(t), id = await accepted(f); f.env.MEMORY_CALL_ENABLED = '0';
  const state = await f.call('callState', { id }); assert.equal(state.call.status, 'failed'); assert.equal(state.call.reason, 'service-disabled');
  await rejects(f.call('callIce', { id }), 503); assert.equal((await f.call('callEnd', { id })).call.status, 'failed');
});

test('persistent sender and room limits cannot be bypassed by cancellation or restarting the module', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 4; n++) { const call = await f.start('request_' + n); await f.call('callEnd', { id: call.callId }); }
  const other = createFamilyCall(f.store, { allowed: f.allowed, clock: f.clock, env: f.env });
  await rejects(other.handle('callStart', { targetId: 'u_family', requestId: 'request_005' }, f.owner), 429);
  f.advance(10 * 60000); const active = await f.start('request_006'); await f.call('callEnd', { id: active.callId });
  await f.store.mutate('rtc_home', old => ({ ...old, budget: { since: f.clock(), count: 12, senders: {} } }));
  await rejects(f.start('request_007'), 429);
});

test('visible history remains bounded while tombstones prevent retries re-ringing after history eviction', async t => {
  const f = await fixture(t); let first;
  for (let n = 0; n < MAX_HISTORY + 2; n++) {
    f.advance(1); const item = await f.start('request_' + n); first ||= item.callId;
    await f.call('callEnd', { id: item.callId }); if (n % 4 === 3) f.advance(10 * 60000);
  }
  const record = await f.store.get('rtc_home'); assert.equal(record.calls.length, MAX_HISTORY); assert.equal(record.starts.length, MAX_HISTORY + 2);
  assert.equal(record.calls.some(item => item.id === first), false); await rejects(f.start('request_0'), 409);
  f.advance(RETENTION); assert.deepEqual((await f.call('callState')).calls, []); assert.equal((await f.store.get('rtc_home')).starts.length, 0);
});

// Model CloudBase's dotted-field object merge rather than LocalStore's full
// document replacement. Arrays (including []) replace the complete field.
function mergeCloudFields(current, update) {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) next[key] = mergeCloudFields(next[key] || {}, value);
    else next[key] = structuredClone(value);
  }
  return next;
}
function mergingCloudWorkers(seed) {
  const records = new Map(Object.entries(structuredClone(seed)));
  return { records, worker() {
    const store = Object.create(CloudStore.prototype);
    store.get = async id => { const snapshot = structuredClone(records.get(id) || null); await new Promise(resolve => setImmediate(resolve)); return snapshot; };
    store.list = async (kind, room) => [...records.values()].filter(item => item.kind === kind && (!room || item.room === room)).map(item => structuredClone(item));
    store.db = { command: { exists: () => undefined } };
    store.collection = {
      async add(doc) { if (records.has(doc._id)) throw Error('duplicate'); records.set(doc._id, structuredClone(doc)); return {}; },
      where(query) { return { async update(data) {
        const current = records.get(query._id);
        if (!current || current._rev !== query._rev) return { updated: 0 };
        records.set(query._id, mergeCloudFields(current, data)); return { updated: 1 };
      } }; }
    };
    return store;
  } };
}

test('CloudStore object-to-array migration preserves in-window limits and CAS charges across workers', async t => {
  for (const legacy of [true, false]) {
    const f = await fixture(t), { callId } = await f.start(); await f.call('callEnd', { id: callId });
    await f.store.mutate('rtc_home', old => ({ ...old, budget: { since: f.clock(), count: 3, senders: legacy ? { u_owner: 3 } : [{ id: 'u_owner', count: 3 }] } }));
    const transport = mergingCloudWorkers(f.store.records);
    const workers = [0, 1].map(() => createFamilyCall(transport.worker(), { allowed: f.allowed, env: f.env, clock: f.clock }));
    const results = await Promise.allSettled(workers.map((worker, index) => worker.handle('callCancelStart', { requestId: 'migration_cancel_' + index }, f.owner)));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.find(item => item.status === 'rejected').reason.status, 429);
    assert.equal(transport.records.get('rtc_home').budget.count, 4);
    assert.deepEqual(transport.records.get('rtc_home').budget.senders, [{ id: 'u_owner', count: 4 }]);
  }
});

test('CloudStore expiry clears legacy and array sender counters before accepting new-window requests', async t => {
  for (const legacy of [true, false]) {
    const f = await fixture(t), { callId } = await f.start(); await f.call('callEnd', { id: callId });
    await f.store.mutate('rtc_home', old => ({ ...old, budget: { since: f.clock(), count: 8, senders: legacy ? { u_owner: 4, old_member: 4 } : [{ id: 'u_owner', count: 4 }, { id: 'old_member', count: 4 }] } }));
    const transport = mergingCloudWorkers(f.store.records), worker = createFamilyCall(transport.worker(), { allowed: f.allowed, env: f.env, clock: f.clock });
    f.advance(10 * 60000);
    await worker.handle('callEnd', { id: callId }, f.owner);
    assert.deepEqual(transport.records.get('rtc_home').budget.senders, []); assert.equal(transport.records.get('rtc_home').budget.count, 0);
    await worker.handle('callCancelStart', { requestId: 'new_window_cancel' }, f.owner);
    assert.deepEqual(transport.records.get('rtc_home').budget.senders, [{ id: 'u_owner', count: 1 }]);
    assert.equal(transport.records.get('rtc_home').budget.count, 1);
  }
});

let sdk;
try { sdk = require('@cloudbase/node-sdk'); } catch { try { sdk = require('../server/node_modules/@cloudbase/node-sdk'); } catch {} }
test('actual offline CloudBase SDK omits empty sender maps but sends the complete empty array', { skip: !sdk }, async () => {
  const query = sdk.init({ env: 'offline-call-budget-contract' }).database().collection('memory_demo_records').where({ _id: 'rtc_offline' });
  const updates = [];
  query._request.send = async (action, params) => { assert.equal(action, 'database.modifyDocument'); updates.push(JSON.parse(params.data).$set); return { data: { updated: 1 } }; };
  await query.update({ budget: { since: 123, count: 0, senders: {} } });
  assert.equal(Object.hasOwn(updates[0], 'budget.senders'), false, 'legacy reset leaves stored sender keys untouched');
  await query.update({ budget: { since: 123, count: 0, senders: [] } });
  assert.deepEqual(updates[1]['budget.senders'], []);
});
