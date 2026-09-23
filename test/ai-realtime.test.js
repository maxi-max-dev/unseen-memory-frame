'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../server/store');
const { createRealtime, LEASE_MS, START_TIMEOUT_MS, RECONCILE_MS } = require('../server/ai-realtime');
const { createTRTC, configuration } = require('../server/ai-realtime-trtc');
const { createApp } = require('../server/server');
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setImmediate(r));
const requestId = n => 'request_number_' + String(n).padStart(8, '0');
const s = { _id: 'session_owner', room: 'home', role: 'owner' };
async function fixture(t, override = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unseen-realtime-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new LocalStore(dir); await store.init(); let clock = Date.now(), revoked = false;
  const starts = [], stops = [], tasks = new Map();
  const provider = { capabilities: () => ({ enabled: true, provider: 'tencent-trtc', reason: '' }),
    start: async e => { starts.push(e); const id = 'task_' + e.requestId; tasks.set(e.providerSession, id); return id; },
    lookup: async e => tasks.get(e.providerSession) || null, stop: async id => { stops.push(id); },
    credentials: e => ({ userId: e.userId, userSig: 'temporary-only', privateMapKey: 'room-only' }), ...override };
  const authenticate = async () => { if (revoked) throw Object.assign(Error('revoked'), { status: 401 }); return s; };
  const options = { provider, authenticate, clock: () => clock }, realtime = createRealtime(store, options);
  const handle = (action, id = requestId(1), user = s, signal) => realtime.handle(action, { requestId: id }, user, 'token', signal);
  return { store, provider, realtime, handle, starts, stops, tasks, advance: ms => { clock += ms; }, revoke: () => { revoked = true; }, second: () => createRealtime(store, options) };
}

test('TRTC is fail-closed, does not inherit vision/cloud credentials and returns no secrets in capabilities', async () => {
  const env = { AI_MODEL: 'hy3', AI_VISION_API_KEY: 'private-vision', TENCENTCLOUD_SECRETID: 'implicit-cloud' };
  assert.equal(configuration(env).enabled, false);
  const provider = createTRTC({ env }); assert.equal(provider.capabilities().enabled, false);
  assert.doesNotMatch(JSON.stringify(provider.capabilities()), /private-vision|implicit-cloud/);
  await assert.rejects(provider.start({}), e => e.status === 503);
});

test('documented TRTC adapter pins safe audio-only fields and handles idempotent stop/lookup', async () => {
  const env = { AI_REALTIME_ENABLED: '1', AI_REALTIME_PROVIDER: 'tencent-trtc', AI_REALTIME_TRTC_ROOM_AUTH: '1', AI_REALTIME_TRTC_APP_ID: '123456',
    AI_REALTIME_TRTC_SDK_SECRET: 'sdk-test', AI_REALTIME_TRTC_SECRET_ID: 'test-id', AI_REALTIME_TRTC_SECRET_KEY: 'test-key',
    AI_REALTIME_LLM_JSON: JSON.stringify({ LLMType: 'openai', Model: 'hy3', APIKey: 'llm-test', APIUrl: 'https://example.com/v1/chat/completions', SystemPrompt: 'override', Tools: ['bad'] }),
    AI_REALTIME_TTS_JSON: JSON.stringify({ TTSType: 'flow', Model: 'flow_01_turbo', VoiceId: 'voice-configured' }) };
  const calls = [], sigs = [];
  const client = { StartAIConversation: async x => { calls.push(x); return { TaskId: 'task' }; }, DescribeAIConversation: async x => { calls.push(x); return { TaskId: 'task' }; }, StopAIConversation: async x => { calls.push(x); throw { code: 'FailedOperation.TaskNotExist' }; } };
  const signer = { genUserSig: (...args) => { sigs.push(args); return 'short-sig'; }, genPrivateMapKeyWithStringRoomID: (...args) => { sigs.push(args); return 'private-map-key'; } };
  const provider = createTRTC({ env, client, signer }), entry = { userId: 'human', agentId: 'bot', rtcRoom: 'opaque-room', providerSession: 'stable-id' };
  assert.equal(await provider.start(entry), 'task'); const request = calls[0];
  assert.equal(request.SessionId, 'stable-id'); assert.equal(request.RoomIdType, 1);
  assert.equal(request.AgentConfig.InterruptMode, 0); assert.equal(request.AgentConfig.InterruptSpeechDuration, 300); assert.equal(request.AgentConfig.TargetUserId, 'human');
  const llm = JSON.parse(request.LLMConfig); assert.equal(llm.Model, 'hy3'); assert.equal(llm.HistoryMode, 1); assert.equal(llm.Streaming, true); assert.equal(llm.Tools, undefined); assert.notEqual(llm.SystemPrompt, 'override');
  const creds = provider.credentials(entry); assert.equal(creds.credentialTtlSeconds, 60);
  assert.doesNotMatch(JSON.stringify(creds), /sdk-test|test-key|llm-test/); assert.ok(sigs.filter(a => a.length === 4).every(a => a[1] === 60 && a[2] === 'opaque-room' && a[3] === 15));
  assert.equal(await provider.lookup(entry), 'task'); await provider.stop('task');
  assert.equal(configuration({ ...env, AI_REALTIME_TRTC_ROOM_AUTH: '0' }).enabled, false);
  assert.equal(configuration({ ...env, AI_REALTIME_LLM_JSON: JSON.stringify({ ...llm, APIUrl: 'http://127.0.0.1/private' }) }).enabled, false);
});

test('default HTTP app requires auth, advertises realtime disabled, rejects starts and keeps text endpoint independent', async t => {
  const f = await fixture(t), app = await createApp({ store: f.store, setupCode: 'local-test-only' });
  const user = await app.api('create', { setupCode: 'local-test-only', name: 'isolated local test' });
  await assert.rejects(app.api('aiRealtimeCapabilities', {}, ''), e => e.status === 401);
  const caps = await app.api('aiRealtimeCapabilities', {}, user.token); assert.equal(caps.enabled, false);
  await assert.rejects(app.api('aiRealtimeStart', { requestId: requestId(1) }, user.token), e => e.status === 503);
  const old = await app.api('aiCapabilities', {}, user.token); assert.equal(old.speechOutput, 'browser');
});

test('start is durable-idempotent across broker instances and credentials do not replay', async t => {
  const f = await fixture(t); const result = await f.handle('aiRealtimeStart'); assert.equal(result.status, 'active'); assert.equal(f.starts.length, 1);
  const again = await f.second().handle('aiRealtimeStart', { requestId: requestId(1) }, s, 'token');
  assert.equal(again.status, 'active'); assert.equal(again.connection, undefined); assert.equal(f.starts.length, 1);
  const record = (await f.store.list('ai-realtime'))[0]; assert.doesNotMatch(JSON.stringify(record), /temporary-only|room-only/);
  await assert.rejects(f.handle('aiRealtimeStatus', requestId(1), { ...s, _id: 'other-owner' }), e => e.status === 404);
  const otherStop = await f.handle('aiRealtimeStop', requestId(1), { ...s, _id: 'other-owner' }); assert.equal(otherStop.status, 'ended'); assert.equal(f.stops.length, 0);
  assert.equal((await f.handle('aiRealtimeStop')).status, 'ended'); assert.equal(f.stops.length, 1);
});

test('stop before start is a durable tombstone and arbitrary stop IDs are bounded', async t => {
  const f = await fixture(t); await f.handle('aiRealtimeStop'); assert.equal((await f.handle('aiRealtimeStart')).status, 'ended'); assert.equal(f.starts.length, 0);
  for (let n = 2; n <= 20; n++) await f.handle('aiRealtimeStop', requestId(n));
  await assert.rejects(f.handle('aiRealtimeStop', requestId(21)), e => e.status === 429);
  assert.equal((await f.store.list('ai-realtime'))[0].entries.length, 20);
});

test('late provider start after stop is stopped without returning media credentials', async t => {
  const pending = deferred(), entered = deferred(), f = await fixture(t, { start: async () => { entered.resolve(); return pending.promise; } });
  const start = f.handle('aiRealtimeStart'); await entered.promise;
  assert.equal((await f.handle('aiRealtimeStop')).status, 'stopping');
  pending.resolve('late-task'); const result = await start;
  assert.equal(result.status, 'ended'); assert.equal(result.connection, undefined); assert.ok(f.stops.includes('late-task'));
});

test('revoked auth after provider start stops it and never releases a signature', async t => {
  const pending = deferred(), entered = deferred(), f = await fixture(t, { start: async () => { entered.resolve(); return pending.promise; } });
  const start = f.handle('aiRealtimeStart'); await entered.promise; f.revoke(); pending.resolve('late-revoked');
  await assert.rejects(start, e => e.status === 401); assert.ok(f.stops.includes('late-revoked'));
});

test('lost provider response keeps stopping until reconciliation finds the task', async t => {
  let taskId = null; const f = await fixture(t, { start: async () => { throw Error('private-vendor-response'); }, lookup: async () => taskId });
  await assert.rejects(f.handle('aiRealtimeStart'), e => e.status === 503 && !e.message.includes('private-vendor-response'));
  assert.equal((await f.handle('aiRealtimeStatus')).status, 'stopping');
  taskId = 'found-after-timeout'; assert.equal((await f.handle('aiRealtimeStop')).status, 'ended'); assert.ok(f.stops.includes(taskId));
});

test('abort during start stops a late result, expired other owners cannot block room capacity', async t => {
  const f = await fixture(t); const other = { ...s, _id: 'other' };
  await f.handle('aiRealtimeStart', requestId(1)); await f.handle('aiRealtimeStart', requestId(2), other);
  f.advance(LEASE_MS + 1);
  const next = await f.handle('aiRealtimeStart', requestId(3), { ...s, _id: 'new-owner' });
  assert.equal(next.status, 'active'); assert.equal(f.stops.length, 2);
  const pending = deferred(), entered = deferred(), g = await fixture(t, { start: async () => { entered.resolve(); return pending.promise; } }), controller = new AbortController();
  const starting = g.handle('aiRealtimeStart', requestId(1), s, controller.signal); await entered.promise; controller.abort(); await tick(); pending.resolve('aborted-task');
  const result = await starting; assert.notEqual(result.status, 'active'); assert.ok(g.stops.includes('aborted-task'));
});

test('room cleanup atomically rechecks a heartbeat renewed after its stale snapshot', async t => {
  const f = await fixture(t); await f.handle('aiRealtimeStart');
  f.advance(LEASE_MS - 1000);
  const captured = deferred(), release = deferred(), originalGet = f.store.get.bind(f.store); let intercept = true;
  f.store.get = async id => {
    const result = await originalGet(id);
    if (id === 'air_home' && intercept) { intercept = false; captured.resolve(); await release.promise; }
    return result;
  };
  const b = f.handle('aiRealtimeStart', requestId(2), { ...s, _id: 'other-owner' });
  await captured.promise;
  assert.equal((await f.handle('aiRealtimeStatus')).status, 'active');
  f.advance(1001); release.resolve(); assert.equal((await b).status, 'active');
  assert.equal((await f.handle('aiRealtimeStatus')).status, 'active'); assert.equal(f.stops.length, 0);
});

test('an old unresolved stop cannot move a subsequently confirmed stop back to stopping', async t => {
  const starting = deferred(), entered = deferred(), lookupEntered = deferred(), lookupDone = deferred(); let lookups = 0;
  const f = await fixture(t, { start: async () => { entered.resolve(); return starting.promise; }, lookup: async () => { if (++lookups === 1) { lookupEntered.resolve(); return lookupDone.promise; } return null; } });
  const start = f.handle('aiRealtimeStart'); await entered.promise;
  const olderStop = f.handle('aiRealtimeStop'); await lookupEntered.promise;
  starting.resolve('created-late'); assert.equal((await start).status, 'ended');
  lookupDone.resolve(null); assert.equal((await olderStop).status, 'ended');
  assert.equal((await f.handle('aiRealtimeStatus')).status, 'ended');
});

test('stop control works after disabling starts, without LLM, TTS or signing secrets', async () => {
  const calls = [], provider = createTRTC({ env: { AI_REALTIME_ENABLED: '0', AI_REALTIME_TRTC_APP_ID: '123456',
    AI_REALTIME_TRTC_SECRET_ID: 'control-id', AI_REALTIME_TRTC_SECRET_KEY: 'control-secret' }, client: {
    DescribeAIConversation: async input => { calls.push(input); return { TaskId: 'existing-task' }; },
    StopAIConversation: async input => { calls.push(input); }
  } });
  assert.equal(provider.capabilities().enabled, false); assert.equal(provider.cleanupReady(), true);
  await assert.rejects(provider.start({}), e => e.status === 503);
  assert.equal(await provider.lookup({ providerSession: 'existing-session' }), 'existing-task');
  await provider.stop('existing-task');
  assert.deepEqual(calls, [{ SdkAppId: 123456, SessionId: 'existing-session' }, { TaskId: 'existing-task' }]);
});

test('malformed provider lookup success is not interpreted as TaskNotExist', async () => {
  let response = {}, missing = false;
  const provider = createTRTC({ env: { AI_REALTIME_TRTC_APP_ID: '123456', AI_REALTIME_TRTC_SECRET_ID: 'id', AI_REALTIME_TRTC_SECRET_KEY: 'key' },
    client: { DescribeAIConversation: async () => { if (missing) throw { code: 'FailedOperation.TaskNotExist' }; return response; } } });
  await assert.rejects(provider.lookup({}), /missing task/);
  response = { Status: 'InProgress' }; await assert.rejects(provider.lookup({}), /missing task/);
  missing = true; assert.equal(await provider.lookup({}), null);
});

test('lookup discovery survives a failed stop and does not depend on another lookup', async t => {
  let lookups = 0, failStop = true;
  const f = await fixture(t, { start: async () => { throw Error('timeout'); },
    lookup: async () => { lookups++; if (lookups > 1) throw Error('offline'); return 'discovered-task'; },
    stop: async () => { if (failStop) throw Error('failed'); } });
  await assert.rejects(f.handle('aiRealtimeStart'), e => e.status === 503);
  const entry = (await f.store.get('air_home')).entries[0];
  assert.equal(entry.taskId, 'discovered-task'); assert.equal(entry.status, 'stopping');
  failStop = false; assert.equal((await f.handle('aiRealtimeStop')).status, 'ended'); assert.equal(lookups, 1);
});

test('trusted sweep keeps an orphan start pending until a task is found and stops a late result', async t => {
  const entered = deferred(), pending = deferred();
  const f = await fixture(t, { start: async () => { entered.resolve(); return pending.promise; } });
  const starting = f.handle('aiRealtimeStart'); await entered.promise;
  f.advance(LEASE_MS + 1);
  assert.equal((await f.second().cleanupExpired()).pending, 1);
  f.advance(START_TIMEOUT_MS + RECONCILE_MS);
  assert.equal((await f.second().cleanupExpired()).pending, 1);
  f.provider.lookup = async () => 'orphan-late-task';
  assert.equal((await f.second().cleanupExpired()).ended, 1);
  pending.resolve('orphan-late-task'); const result = await starting;
  assert.equal(result.status, 'ended'); assert.equal(result.connection, undefined);
  assert.ok(f.stops.includes('orphan-late-task'));
});

test('old empty lookup cannot mark a concurrently discovered, failed-stop task ended', async t => {
  const entered = deferred(), done = deferred(); let lookups = 0, failStop = true;
  const f = await fixture(t, { start: async () => { throw Error('timeout'); },
    lookup: async () => { if (++lookups === 2) { entered.resolve(); return done.promise; } return lookups > 2 ? 'task-found' : null; },
    stop: async () => { if (failStop) throw Error('stop offline'); } });
  await assert.rejects(f.handle('aiRealtimeStart'));
  f.advance(RECONCILE_MS + 1);
  const older = f.handle('aiRealtimeStop'); await entered.promise;
  assert.equal((await f.handle('aiRealtimeStop')).status, 'stopping');
  done.resolve(null); assert.equal((await older).status, 'stopping');
  failStop = false; assert.equal((await f.realtime.cleanupExpired()).ended, 1);
});

test('storage failure after provider success still attempts direct stop and preserves reconciliation', async t => {
  const f = await fixture(t); const mutate = f.store.mutate.bind(f.store); let unavailable = false;
  f.store.mutate = (...args) => { if (unavailable) throw Error('private database failure'); return mutate(...args); };
  f.provider.start = async () => { unavailable = true; return 'accepted-before-db-failure'; };
  await assert.rejects(f.handle('aiRealtimeStart'), e => e.status === 503 && !e.message.includes('private'));
  assert.ok(f.stops.includes('accepted-before-db-failure'));
  unavailable = false; const record = await f.store.get('air_home');
  assert.equal(record.entries[0].attempted, true);
  f.provider.lookup = async () => 'accepted-before-db-failure';
  f.advance(START_TIMEOUT_MS + RECONCILE_MS + 1);
  assert.equal((await f.second().cleanupExpired()).ended, 1);
});

test('failed stop bookkeeping on the expired-start return path still stops its known task', async t => {
  const f = await fixture(t); const mutate = f.store.mutate.bind(f.store); let unavailable = false;
  f.store.mutate = async (...args) => {
    if (unavailable) throw Error('private storage error');
    const result = await mutate(...args);
    if (result?.entries.some(e => e.taskId)) unavailable = true;
    return result;
  };
  f.provider.start = async () => { f.advance(LEASE_MS + 1); return 'expired-known-task'; };
  await assert.rejects(f.handle('aiRealtimeStart'), e => e.status === 503 && !e.message.includes('private'));
  assert.ok(f.stops.includes('expired-known-task'));
});

test('bounded cross-family sweeps retry failures fairly without family traffic', async t => {
  const f = await fixture(t); let failStop = true; const stop = f.provider.stop;
  f.provider.stop = async id => { if (failStop && id.endsWith('00000001')) throw Error('provider-secret'); return stop(id); };
  await f.handle('aiRealtimeStart'); await f.handle('aiRealtimeStart', requestId(2), { ...s, room: 'second-home' });
  f.advance(LEASE_MS + 1);
  const first = await f.realtime.cleanupExpired({ maxEntries: 1 });
  assert.equal(first.pending, 1); assert.equal(first.deferred, 1);
  const second = await f.realtime.cleanupExpired({ maxEntries: 1 });
  assert.equal(second.ended, 1); assert.equal(second.deferred, 1);
  assert.doesNotMatch(JSON.stringify(second), /home|task_|request_number|secret/);
  failStop = false; assert.equal((await f.second().cleanupExpired()).ended, 1);
  assert.equal((await f.realtime.cleanupExpired()).candidates, 0);
});

test('sweep rechecks a lease renewed since its snapshot and obeys time budget', async t => {
  const f = await fixture(t); await f.handle('aiRealtimeStart'); f.advance(LEASE_MS + 1);
  const list = f.store.list.bind(f.store);
  f.store.list = async (...args) => {
    const records = await list(...args);
    await f.store.mutate('air_home', r => { r.entries[0].leaseUntil += LEASE_MS; return r; });
    return records;
  };
  assert.equal((await f.realtime.cleanupExpired()).skipped, 1); assert.equal(f.stops.length, 0);
  f.store.list = list; f.advance(LEASE_MS + 1);
  assert.equal((await f.realtime.cleanupExpired({ budgetMs: 0 })).deferred, 1); assert.equal(f.stops.length, 0);
  await assert.rejects(f.realtime.cleanupExpired({ maxEntries: 0 }), e => e.status === 400);
});

test('trusted emergency sweep stops active sessions only with explicit stopAll even if starts are disabled', async t => {
  const f = await fixture(t); await f.handle('aiRealtimeStart');
  f.provider.capabilities = () => ({ enabled: false });
  assert.equal((await f.realtime.cleanupExpired()).candidates, 0);
  assert.equal((await f.realtime.cleanupExpired({ stopAll: true })).ended, 1); assert.equal(f.stops.length, 1);
});

test('private Timer runner is inert by default and has no family or HTTP action', async t => {
  const { createCleanupHandler, TRIGGER } = require('../server/ai-realtime-cleanup');
  let stores = 0, providers = 0;
  const options = { env: {}, storeFactory: () => { stores++; throw Error('private key'); }, providerFactory: () => { providers++; } };
  assert.deepEqual(await createCleanupHandler(options)({ Type: 'Timer', TriggerName: TRIGGER }), { enabled: false, verification: 'not-run' });
  assert.equal(stores + providers, 0);
  options.env = { AI_REALTIME_CLEANUP_ENABLED: '1', AI_REALTIME_CLEANUP_STOP_ALL: '1', MEMORY_CLOUDBASE_ENV: 'existing-env' };
  await assert.rejects(createCleanupHandler(options)({ Type: 'HTTP', TriggerName: TRIGGER }), /private Timer/);
  assert.equal(stores + providers, 0);
  const f = await fixture(t); await f.handle('aiRealtimeStart'); f.provider.capabilities = () => ({ enabled: false });
  f.provider.cleanupReady = () => true;
  const reports = [];
  const run = createCleanupHandler({ ...options, storeFactory: () => f.store, providerFactory: () => f.provider, report: summary => reports.push(summary) });
  const result = await run({ Type: 'Timer', TriggerName: TRIGGER });
  assert.equal(result.ok, true); assert.equal(result.ended, 1);
  assert.deepEqual(reports, [result]); assert.doesNotMatch(JSON.stringify(reports), /task_|session_|home|request_number/);
  const broken = createCleanupHandler({ ...options, providerFactory: () => f.provider });
  await assert.rejects(broken({ Type: 'Timer', TriggerName: TRIGGER }), e => !e.message.includes('private key'));
});
