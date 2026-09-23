'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const controllerModule = import('../server/public/camera-presence.mjs');
const adapterModule = import('../server/public/camera-adapters.mjs');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function fixture(options = {}) {
  const { createCameraPresenceController } = await controllerModule;
  let time = 0;
  const calls = [];
  const sessions = [];
  const errors = [];
  let stops = 0;
  const timers = scheduler();
  const adapter = {
    capabilities: { presence: true, gaze: options.gaze === true },
    async start(session) { sessions.push(session); },
    async stop() { stops++; },
  };
  const controller = createCameraPresenceController({ adapter, now: () => time, ...timers,
    onGreet: (event) => { calls.push(event); return options.onGreet?.(event); }, onError: (error) => errors.push(error),
    dwellMs: 2000, cooldownMs: 10000, rearmAbsentMs: 2000, maxAgeMs: 1500, maxGapMs: 1000,
    ...options.policy });
  const sample = async (at, presence = 'present', overrides = {}, index = sessions.length - 1) => {
    time = at;
    sessions[index].onObservation({ version: 1, observedAt: at, presence, attention: 'unknown', privacy: 'off', ...overrides });
    await settle();
  };
  const enable = async () => {
    await controller.setContext({ visible: true, privacyAllowed: true });
    await controller.enable({ consent: true });
  };
  return { controller, adapter, sessions, calls, errors, sample, enable, timers, setTime: (at) => { time = at; }, stops: () => stops };
}

test('camera controller is disabled and needs explicit consent, visibility, and privacy context', async () => {
  const f = await fixture();
  assert.equal(f.controller.getState().enabled, false);
  assert.equal(f.sessions.length, 0);
  await assert.rejects(f.controller.enable(), /consent/);
  await f.controller.enable({ consent: true });
  assert.equal(f.sessions.length, 0);
  await f.controller.setContext({ visible: true });
  assert.equal(f.sessions.length, 0);
  await f.controller.setContext({ privacyAllowed: true });
  assert.equal(f.sessions.length, 1);
  await f.controller.dispose();
});

test('continuous presence needs full dwell and greets only once while a person stays', async () => {
  const f = await fixture(); await f.enable();
  await f.sample(0); await f.sample(1000);
  assert.equal(f.calls.length, 0);
  await f.sample(2000);
  for (let i = 3000; i <= 15000; i += 1000) await f.sample(i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].reason, 'presence');
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['observedAt', 'reason', 'signal']);
  await f.controller.dispose();
});

test('rearming needs continuously verified absence and respects cooldown on a return visit', async () => {
  const f = await fixture(); await f.enable();
  for (const at of [0, 1000, 2000]) await f.sample(at);
  for (const at of [3000, 4000, 5000]) await f.sample(at, 'absent');
  assert.equal(f.controller.getState().armed, true);
  for (let at = 6000; at <= 11000; at += 1000) await f.sample(at);
  assert.equal(f.calls.length, 1);
  await f.sample(12000);
  assert.equal(f.calls.length, 2);
  await f.controller.dispose();
});

test('unknown or disconnected samples never count as absence or rearm the same visit', async () => {
  const f = await fixture(); await f.enable();
  for (const at of [0, 1000, 2000]) await f.sample(at);
  await f.sample(3000, 'absent');
  await f.sample(4000, 'unknown');
  await f.sample(5000, 'absent');
  await f.sample(6000, 'absent');
  assert.equal(f.controller.getState().armed, false);
  for (const at of [10000, 11000, 12000]) await f.sample(at);
  assert.equal(f.calls.length, 1);
  await f.controller.dispose();
});

for (const [name, bad] of [
  ['stale', { observedAt: -500 }], ['future', { observedAt: 2500 }],
  ['duplicate', { observedAt: 1000 }], ['unknown privacy', { privacy: 'unknown' }],
  ['privacy mode', { privacy: 'on' }], ['unknown presence', { presence: 'unknown' }],
  ['unsupported version', { version: 2 }], ['invalid attention', { attention: true }],
]) {
  test(`${name} evidence interrupts dwell and cannot greet`, async () => {
    const f = await fixture(); await f.enable();
    await f.sample(0); await f.sample(1000); await f.sample(2000, 'present', bad);
    await f.sample(3000); await f.sample(4000);
    assert.equal(f.calls.length, 0);
    await f.sample(5000);
    assert.equal(f.calls.length, 1);
    await f.controller.dispose();
  });
}

test('a detection gap resets dwell even if the next sample itself is fresh', async () => {
  const f = await fixture(); await f.enable();
  await f.sample(0); await f.sample(1000); await f.sample(4000); await f.sample(5000);
  assert.equal(f.calls.length, 0);
  await f.sample(6000); assert.equal(f.calls.length, 1);
  await f.controller.dispose();
});

test('gaze mode never treats face presence or unsupported claimed looking as eye contact', async () => {
  const f = await fixture({ policy: { requireGaze: true } }); await f.enable();
  for (const at of [0, 1000, 2000, 3000]) await f.sample(at, 'present', { attention: 'looking' });
  assert.equal(f.calls.length, 0);
  await f.controller.dispose();
  const g = await fixture({ gaze: true, policy: { requireGaze: true } }); await g.enable();
  await g.sample(0, 'present', { attention: 'looking' });
  await g.sample(1000); // unknown gaze resets attention dwell
  for (const at of [2000, 3000, 4000]) await g.sample(at, 'present', { attention: 'looking' });
  assert.equal(g.calls.length, 1); assert.equal(g.calls[0].reason, 'attention');
  await g.controller.dispose();
});

for (const [name, patch] of [['hidden', { visible: false }], ['busy', { busy: true }], ['privacy denied', { privacyAllowed: false }]]) {
  test(`${name} stops capture, cancels pending greeting, and rejects late observations`, async () => {
    const pending = deferred();
    const f = await fixture({ onGreet: () => pending.promise }); await f.enable();
    for (const at of [0, 1000, 2000]) await f.sample(at);
    await f.controller.setContext(patch);
    assert.equal(f.stops(), 1); assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.sessions[0].signal.aborted, true);
    for (const at of [3000, 4000, 5000]) await f.sample(at, 'absent');
    assert.equal(f.controller.getState().armed, false);
    pending.resolve(); await settle(); await f.controller.dispose();
  });
}

test('disable/reenable does not greet the same visit again and old errors cannot reset new dwell', async () => {
  const f = await fixture(); await f.enable();
  await f.sample(0);
  await f.controller.disable(); await f.enable();
  await f.sample(1000); f.sessions[0].onError(); await f.sample(2000); await f.sample(3000);
  assert.equal(f.calls.length, 1); assert.equal(f.errors.length, 0);
  await f.controller.disable(); await f.enable();
  for (const at of [13000, 14000, 15000]) await f.sample(at);
  assert.equal(f.calls.length, 1);
  await f.controller.dispose();
  await assert.rejects(f.controller.enable({ consent: true }), /disposed/);
});

test('failed greeting is contained and consumes the visit to avoid repeated interruptions', async () => {
  const f = await fixture({ onGreet: () => { throw new Error('private callback detail'); } }); await f.enable();
  for (const at of [0, 1000, 2000, 3000, 4000]) await f.sample(at);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.errors, [{ code: 'greeting-failed' }]);
  await f.controller.dispose();
});

test('an invitation signal remains cancellable after a synchronous callback has returned', async () => {
  const f = await fixture(); await f.enable();
  for (const at of [0, 1000, 2000]) await f.sample(at);
  assert.equal(f.calls[0].signal.aborted, false);
  await f.controller.disable();
  assert.equal(f.calls[0].signal.aborted, true);
});

test('hide or privacy revocation requires manual enable; simply restoring context never wakes the camera', async () => {
  for (const key of ['visible', 'privacyAllowed']) {
    const f = await fixture(); await f.enable();
    await f.controller.setContext({ [key]: false });
    assert.equal(f.controller.getState().enabled, false);
    await f.controller.setContext({ [key]: true });
    assert.equal(f.sessions.length, 1);
    await f.controller.enable({ consent: true });
    assert.equal(f.sessions.length, 2);
    await f.controller.dispose();
  }
});

test('hung observation reads expire an invitation; continued fresh evidence extends only its freshness window', async () => {
  const f = await fixture(); await f.enable();
  for (const at of [0, 1000, 2000]) await f.sample(at);
  assert.equal(f.timers.size(), 1);
  await f.sample(2500);
  f.setTime(3501); await f.timers.next();
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.timers.size(), 1);
  f.setTime(4001); await f.timers.next();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.timers.size(), 0);
  assert.equal(f.controller.getState().armed, false);
  await f.controller.dispose();
});

test('bad context updates are atomic and startup/cleanup failures fail closed', async () => {
  const f = await fixture(); await f.enable();
  assert.throws(() => f.controller.setContext({ visible: false, busy: 'false' }), /boolean/);
  assert.equal(f.controller.getState().context.visible, true);
  f.adapter.stop = async () => { throw new Error('stop failed'); };
  await f.controller.setContext({ busy: true });
  await f.controller.setContext({ busy: false });
  assert.equal(f.sessions.length, 1); assert.equal(f.controller.getState().enabled, false);
  const g = await fixture();
  g.adapter.start = async () => { throw new Error('permission denied'); };
  await g.enable();
  assert.equal(g.controller.getState().enabled, false);
  assert.deepEqual(g.errors, [{ code: 'adapter-start-failed' }]);
});

function scheduler() {
  const pending = new Map(); let id = 0;
  return {
    schedule: (fn) => { pending.set(++id, fn); return id; },
    cancel: (key) => pending.delete(key),
    size: () => pending.size,
    async next() { const [key, fn] = pending.entries().next().value; pending.delete(key); await fn(); await settle(); },
  };
}

async function startAdapter(adapter) {
  const abort = new AbortController(); const samples = []; const errors = [];
  await adapter.start({ signal: abort.signal, onObservation: (s) => samples.push(s), onError: (e) => errors.push(e) });
  await settle();
  return { abort, samples, errors };
}

test('native SDK adapter exposes face presence only and checks privacy before and after faces', async () => {
  const { createLinkSdkPresenceAdapter } = await adapterModule;
  const clock = scheduler(); const reads = []; let privacy = 'off'; let faces = [{}];
  const adapter = createLinkSdkPresenceAdapter({ ...clock, now: () => 500,
    readPrivacy: async () => { reads.push('privacy'); return privacy; },
    readFaces: async () => { reads.push('faces'); return faces; } });
  assert.equal(reads.length, 0);
  assert.equal(adapter.capabilities.gaze, false);
  const run = await startAdapter(adapter);
  assert.deepEqual(reads, ['privacy', 'faces', 'privacy']);
  assert.deepEqual(run.samples[0], { version: 1, observedAt: 500, presence: 'present', attention: 'unknown', privacy: 'off' });
  privacy = 'on'; reads.length = 0; await clock.next();
  assert.deepEqual(reads, ['privacy']); assert.equal(run.samples.at(-1).presence, 'unknown');
  privacy = 'off'; faces = []; await clock.next();
  assert.equal(run.samples.at(-1).presence, 'absent');
  adapter.stop(); assert.equal(clock.size(), 0);
});

test('native SDK errors, invalid result, and privacy races report unknown rather than absence', async () => {
  const { createLinkSdkPresenceAdapter } = await adapterModule;
  for (const readFaces of [async () => { throw new Error('SDK unsupported'); }, async () => null, async () => Array(11)]) {
    const clock = scheduler();
    const adapter = createLinkSdkPresenceAdapter({ ...clock, readPrivacy: async () => 'off', readFaces });
    const run = await startAdapter(adapter);
    assert.equal(run.samples[0].presence, 'unknown'); assert.equal(run.samples[0].privacy, 'unknown');
    assert.equal(run.errors.length, 1); adapter.stop();
  }
  const clock = scheduler(); let reads = 0;
  const adapter = createLinkSdkPresenceAdapter({ ...clock, readPrivacy: async () => ++reads === 1 ? 'off' : 'on', readFaces: async () => [{}] });
  const run = await startAdapter(adapter);
  assert.equal(run.samples[0].privacy, 'on'); assert.equal(run.samples[0].presence, 'unknown'); adapter.stop();
});

test('native polling serializes reads, ignores late results, and does not read faces after cancel', async () => {
  const { createLinkSdkPresenceAdapter } = await adapterModule;
  const clock = scheduler(); const pending = deferred(); let faceReads = 0;
  const adapter = createLinkSdkPresenceAdapter({ ...clock, readPrivacy: () => pending.promise, readFaces: async () => { faceReads++; return [{}]; } });
  const run = await startAdapter(adapter);
  assert.equal(clock.size(), 0);
  run.abort.abort(); pending.resolve('off'); await settle();
  assert.equal(faceReads, 0); assert.equal(run.samples.length, 0); assert.equal(clock.size(), 0);
});

function browserFixture() {
  const clock = scheduler(); let stops = 0; let requests = 0; let constraints;
  const track = new EventTarget(); Object.assign(track, { readyState: 'live', enabled: true, muted: false,
    stop() { stops++; this.readyState = 'ended'; } });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { srcObject: null, pause() {}, async play() {} };
  return { clock, stream, track, video,
    options: { ...clock, createVideo: () => video, getUserMedia: async (value) => { requests++; constraints = value; return stream; } },
    stops: () => stops, requests: () => requests, constraints: () => constraints };
}

test('browser seam requires an injected detector, requests video only after start, and releases everything', async () => {
  const { createBrowserCameraAdapter } = await adapterModule;
  assert.throws(() => createBrowserCameraAdapter(), /detector/);
  const f = browserFixture();
  const adapter = createBrowserCameraAdapter({ ...f.options, deviceId: 'selected-camera', detector: {
    capabilities: { presence: true, gaze: false }, async detect(input) { assert.equal(input, f.video); return { presence: 'present', attention: 'looking' }; },
  } });
  assert.equal(f.requests(), 0);
  const run = await startAdapter(adapter);
  assert.equal(f.requests(), 1); assert.equal(f.constraints().audio, false);
  assert.deepEqual(f.constraints().video.deviceId, { exact: 'selected-camera' });
  assert.equal(run.samples[0].attention, 'unknown');
  run.abort.abort();
  assert.equal(f.stops(), 1); assert.equal(f.video.srcObject, null); assert.equal(f.clock.size(), 0);
  adapter.stop(); assert.equal(f.stops(), 1);
});

test('browser stop during a pending permission prompt releases a late stream without starting detection', async () => {
  const { createBrowserCameraAdapter } = await adapterModule;
  const f = browserFixture(); const pending = deferred(); let detections = 0;
  const adapter = createBrowserCameraAdapter({ ...f.options, getUserMedia: () => pending.promise,
    detector: { capabilities: { presence: true }, async detect() { detections++; } } });
  const abort = new AbortController();
  const start = adapter.start({ signal: abort.signal, onObservation() {} });
  abort.abort(); pending.resolve(f.stream);
  await assert.rejects(start, { name: 'AbortError' });
  assert.equal(f.stops(), 1); assert.equal(detections, 0); assert.equal(f.clock.size(), 0);
});

test('browser permission denial and playback failure leave no stream or polling behind', async () => {
  const { createBrowserCameraAdapter } = await adapterModule;
  for (const permissionDenied of [false, true]) {
    const f = browserFixture();
    if (permissionDenied) f.options.getUserMedia = async () => { throw new Error('permission denied'); };
    else f.video.play = async () => { throw new Error('play rejected'); };
    const adapter = createBrowserCameraAdapter({ ...f.options,
      detector: { capabilities: { presence: true }, async detect() { assert.fail('must not detect'); } } });
    await assert.rejects(startAdapter(adapter));
    assert.equal(f.stops(), permissionDenied ? 0 : 1);
    assert.equal(f.video.srcObject, null); assert.equal(f.clock.size(), 0);
  }
});

test('browser delayed detector cannot emit after stop, and muted tracks do not produce presence', async () => {
  const { createBrowserCameraAdapter } = await adapterModule;
  for (const stop of [false, true]) {
    const f = browserFixture(); const pending = deferred();
    const adapter = createBrowserCameraAdapter({ ...f.options,
      detector: { capabilities: { presence: true, gaze: true }, detect: () => pending.promise } });
    const run = await startAdapter(adapter);
    if (stop) adapter.stop(); else f.track.muted = true;
    pending.resolve({ presence: 'present', attention: 'looking' }); await settle();
    if (stop) assert.equal(run.samples.length, 0);
    else assert.equal(run.samples[0].presence, 'unknown');
    adapter.stop();
  }
});

test('camera unplug ends polling, emits unknown, and releases video tracks', async () => {
  const { createBrowserCameraAdapter } = await adapterModule;
  const f = browserFixture();
  const adapter = createBrowserCameraAdapter({ ...f.options,
    detector: { capabilities: { presence: true }, async detect() { return { presence: 'present', attention: 'unknown' }; } } });
  const run = await startAdapter(adapter);
  f.track.dispatchEvent(new Event('ended'));
  assert.equal(run.samples.at(-1).presence, 'unknown'); assert.equal(run.errors.length, 1);
  assert.equal(f.stops(), 1); assert.equal(f.clock.size(), 0); assert.equal(f.video.srcObject, null);
});

test('controller and browser adapter recover from unplug with one explicit enable after replug', async () => {
  const { createBrowserCameraAdapter } = await adapterModule;
  const { createCameraPresenceController } = await controllerModule;
  const first = browserFixture(); const second = browserFixture(); const errors = [];
  let requests = 0;
  const adapter = createBrowserCameraAdapter({ ...first.options,
    getUserMedia: async () => (++requests === 1 ? first.stream : second.stream),
    detector: { capabilities: { presence: true }, async detect() { return { presence: 'present', attention: 'unknown' }; } } });
  const controller = createCameraPresenceController({ adapter, onGreet() {}, onError: (error) => errors.push(error) });
  await controller.setContext({ visible: true, privacyAllowed: true });
  await controller.enable({ consent: true }); await settle();
  assert.equal(requests, 1); assert.equal(controller.getState().running, true);
  first.track.readyState = 'ended'; first.track.dispatchEvent(new Event('ended'));
  assert.equal(controller.getState().enabled, false); assert.equal(controller.getState().running, false);
  assert.equal(first.stops(), 1); assert.equal(first.clock.size(), 0);
  await controller.enable({ consent: true }); await settle();
  assert.equal(requests, 2); assert.equal(controller.getState().running, true);
  assert.equal(second.stops(), 0); assert.deepEqual(errors, [{ code: 'adapter-stopped' }]);
  await controller.dispose(); assert.equal(second.stops(), 1);
});

test('fatal errors during startup queue cleanup without returning a promise that deadlocks adapter.start', { timeout: 1000 }, async () => {
  const f = await fixture(); let starts = 0;
  f.adapter.start = async (session) => {
    f.sessions.push(session);
    if (++starts === 1) await session.onError({ code: 'adapter-stopped', fatal: true });
  };
  await f.enable();
  assert.equal(f.controller.getState().enabled, false);
  await f.controller.enable({ consent: true });
  assert.equal(starts, 2); assert.equal(f.controller.getState().running, true);
  f.sessions[0].onError({ code: 'adapter-stopped', fatal: true });
  assert.equal(f.controller.getState().enabled, true); assert.equal(f.controller.getState().running, true);
  assert.deepEqual(f.errors, [{ code: 'adapter-stopped' }]);
  await f.controller.dispose();
});

test('unplug during pending video playback cancels the old startup before the explicit replacement starts', { timeout: 1000 }, async () => {
  const { createBrowserCameraAdapter } = await adapterModule;
  const { createCameraPresenceController } = await controllerModule;
  const first = browserFixture(); const second = browserFixture(); const playback = deferred();
  first.video.play = () => playback.promise;
  let requests = 0;
  const adapter = createBrowserCameraAdapter({ ...first.options,
    getUserMedia: async () => (++requests === 1 ? first.stream : second.stream),
    createVideo: () => requests === 1 ? first.video : second.video,
    detector: { capabilities: { presence: true }, async detect() { return { presence: 'present', attention: 'unknown' }; } } });
  const controller = createCameraPresenceController({ adapter, onGreet() {} });
  await controller.setContext({ visible: true, privacyAllowed: true });
  const startup = controller.enable({ consent: true }); await settle();
  first.track.readyState = 'ended'; first.track.dispatchEvent(new Event('ended'));
  assert.equal(controller.getState().enabled, false); assert.equal(first.stops(), 1);
  const restart = controller.enable({ consent: true });
  playback.resolve(); await Promise.all([startup, restart]); await settle();
  assert.equal(requests, 2); assert.equal(controller.getState().running, true);
  assert.equal(second.stops(), 0); assert.equal(first.video.srcObject, null);
  assert.equal(second.video.srcObject, second.stream);
  await controller.dispose(); assert.equal(second.stops(), 1);
});

test('recoverable SDK read errors retain the enabled controller and polling resumes without another enable', async () => {
  const { createLinkSdkPresenceAdapter } = await adapterModule;
  const { createCameraPresenceController } = await controllerModule;
  const clock = scheduler(); const errors = []; let reads = 0;
  const adapter = createLinkSdkPresenceAdapter({ ...clock, readPrivacy: async () => 'off',
    readFaces: async () => { if (++reads === 1) throw new Error('transient SDK read error'); return []; } });
  const controller = createCameraPresenceController({ adapter, onGreet() {}, onError: (error) => errors.push(error) });
  await controller.setContext({ visible: true, privacyAllowed: true });
  await controller.enable({ consent: true }); await settle();
  assert.equal(controller.getState().enabled, true); assert.equal(controller.getState().running, true);
  assert.deepEqual(errors, [{ code: 'observation-unavailable' }]);
  await clock.next();
  assert.equal(reads, 2); assert.equal(controller.getState().running, true);
  await controller.dispose(); assert.equal(clock.size(), 0);
});
