'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server/public/ai-realtime.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(r => setImmediate(r));
function fixture(options = {}) {
  const calls = [], states = [], timers = new Map(), listeners = {}, tracks = [], instances = []; let sequence = 0, hidden = false, acquisitions = 0, sdkLoads = 0;
  const stream = () => { const track = { enabled: true, stops: 0, stop() { this.stops++; } }; tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; };
  class RTC {
    constructor() { this.events = {}; this.joins = 0; this.publishes = 0; this.destroyed = 0; this.remoteMutes = []; this.localUpdates = []; instances.push(this); }
    on(event, fn) { this.events[event] = fn; }
    async enterRoom(data) { this.joins++; this.room = data; if (options.enter) return options.enter(this); }
    async startLocalAudio(data) { this.publishes++; this.audio = data; if (options.publish) return options.publish(this); }
    async updateLocalAudio(data) { this.localUpdates.push(data); }
    async muteRemoteAudio(id, muted) { this.remoteMutes.push({ id, muted }); }
    async stopLocalAudio() { this.audioStopped = true; }
    async exitRoom() { this.exited = true; }
    destroy() { this.destroyed++; }
  }
  const sdk = { create: () => new RTC(), setLogLevel() {}, EVENT: { ERROR: 'error', KICKED_OUT: 'kicked', AUTOPLAY_FAILED: 'autoplay', CONNECTION_STATE_CHANGED: 'connection', REMOTE_AUDIO_AVAILABLE: 'audio', REMOTE_USER_EXIT: 'exit' } };
  const context = vm.createContext({ document: { hidden: false, addEventListener: (e, fn) => { listeners[e] = fn; } }, addEventListener: (e, fn) => { listeners[e] = fn; }, AbortController,
    crypto: { randomUUID: () => `test-session-${++sequence}` }, setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const normal = action => action === 'aiRealtimeStart' ? { status: 'active', provider: 'tencent-trtc', connection: { sdkAppId: 1, userId: 'user', agentId: 'bot', strRoomId: 'random-room', userSig: 'short', privateMapKey: 'short-room' }, expiresAt: Date.now() + 600000 } : { status: action === 'aiRealtimeStop' ? 'ended' : 'active' };
  const client = context.MemoryRealtime.createClient({ request: async (action, data, opts) => { calls.push({ action, data, opts }); return options.request ? options.request(action, data, opts, normal) : normal(action); },
    loadSDK: async () => { sdkLoads++; return sdk; }, acquire: async () => { acquisitions++; return options.acquire ? options.acquire(stream) : stream(); },
    permitted: () => !hidden, onState: value => states.push(value), stopState: options.stopState });
  return { client, context, tracks, calls, states, instances, timers, listeners, hide: () => { hidden = true; }, acquisitions: () => acquisitions, sdkLoads: () => sdkLoads };
}

test('constructing realtime client neither opens microphone nor loads SDK; explicit start is full duplex', async () => {
  const f = fixture(); assert.equal(f.acquisitions(), 0); assert.equal(f.sdkLoads(), 0);
  await f.client.start(); assert.equal(f.acquisitions(), 1); assert.equal(f.instances[0].publishes, 1);
  assert.equal(f.instances[0].room.autoReceiveVideo, false); assert.equal(f.instances[0].room.autoReceiveAudio, false);
  assert.equal(f.instances[0].audio.option.audioTrack, f.tracks[0]);
  await f.instances[0].events.audio({ userId: 'stranger' }); assert.equal(f.instances[0].remoteMutes.length, 0);
  await f.instances[0].events.audio({ userId: 'bot' }); assert.equal(f.instances[0].remoteMutes[0].muted, false);
  assert.equal(f.tracks[0].enabled, true); assert.equal(f.tracks[0].stops, 0);
  await f.client.mute(); assert.equal(f.tracks[0].enabled, false); await f.client.mute(); assert.equal(f.tracks[0].enabled, true);
  await f.client.stop(); assert.ok(f.tracks[0].stops); assert.ok(f.instances[0].destroyed); assert.equal(f.timers.size, 0);
});

test('closing while microphone permission is pending releases the late stream without starting provider', async () => {
  const pending = deferred(); let makeStream; const f = fixture({ acquire: factory => { makeStream = factory; return pending.promise; } });
  const starting = f.client.start(); await f.client.stop(); pending.resolve(makeStream()); await starting;
  assert.ok(f.tracks[0].stops); assert.equal(f.calls.length, 0); assert.equal(f.sdkLoads(), 0);
});

test('permission denied does not allocate a paid task', async () => {
  const f = fixture({ acquire: () => Promise.reject(Object.assign(Error('permission'), { name: 'NotAllowedError' })) });
  await f.client.start(); assert.equal(f.calls.length, 0); assert.match(f.states.at(-1).message, /权限/); assert.equal(f.client.busy(), false);
});

test('stop during provider start persists same cancel ID and a late response cannot join or reopen mic', async () => {
  const pending = deferred(), entered = deferred(); const f = fixture({ request: (action, data, opts, normal) => { if (action === 'aiRealtimeStart') { entered.resolve(); return pending.promise; } return normal(action); } });
  const starting = f.client.start(); await entered.promise; await f.client.stop();
  assert.ok(f.tracks[0].stops); assert.equal(f.calls[0].opts.signal.aborted, true); assert.equal(f.calls[1].data.requestId, f.calls[0].data.requestId);
  pending.resolve({ status: 'active', provider: 'tencent-trtc', connection: {} }); await starting;
  assert.equal(f.instances[0].joins, 0); assert.equal(f.instances[0].publishes, 0); assert.equal(f.client.busy(), false);
});

test('stop during SDK room entry destroys transport and late entry never publishes', async () => {
  const pending = deferred(), entered = deferred(); const f = fixture({ enter: () => { entered.resolve(); return pending.promise; } });
  const starting = f.client.start(); await entered.promise; await f.client.stop(); pending.resolve(); await starting;
  assert.ok(f.tracks[0].stops); assert.ok(f.instances[0].destroyed); assert.equal(f.instances[0].publishes, 0);
});

test('hidden state discovered after publish closes all resources and never marks connected', async () => {
  const pending = deferred(), entered = deferred(); const f = fixture({ publish: () => { entered.resolve(); return pending.promise; } });
  const starting = f.client.start(); await entered.promise; f.hide(); pending.resolve(); await starting;
  await settle();
  assert.ok(f.tracks[0].stops); assert.ok(f.instances[0].destroyed); assert.equal(f.states.some(s => s.phase === 'connected'), false);
  assert.equal(f.client.busy(), false); assert.ok(f.calls.some(c => c.action === 'aiRealtimeStop'));
});

test('heartbeat loss, expiry, and SDK errors release media and do not automatically reconnect', async () => {
  for (const mode of ['heartbeat', 'expiry', 'error', 'autoplay']) {
    const f = fixture({ request: (action, data, opts, normal) => { if (mode === 'heartbeat' && action === 'aiRealtimeStatus') throw Error('offline'); return normal(action); } });
    await f.client.start();
    if (mode === 'heartbeat') await [...f.timers.values()].find(t => t.ms === 10000).fn();
    else if (mode === 'expiry') await [...f.timers.values()].find(t => t.ms > 45000).fn();
    else f.instances[0].events[mode]({});
    await settle(); assert.ok(f.tracks[0].stops, mode); assert.equal(f.client.busy(), false, mode); assert.equal(f.acquisitions(), 1);
  }
});

test('page keeps original navigation, offers visible chat card and includes only lazy SDK import', () => {
  const root = path.join(__dirname, '../server/public');
  const chat = fs.readFileSync(path.join(root, 'ai-conversation.js'), 'utf8'), shell = fs.readFileSync(path.join(root, 'family-experience.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(chat, /id="aiHomeChat"/); assert.match(chat, /id="aiHomeLive"/); assert.match(chat, /#familyHome \.subheading/);
  assert.ok(shell.indexOf('id="homeTab"') < shell.indexOf('id="plus"')); assert.ok(shell.indexOf('id="plus"') < shell.indexOf('id="mineTab"'));
  assert.match(html, /src="\/ai-realtime\.js/); assert.doesNotMatch(html, /src="[^"]*trtc/);
  assert.match(source, /import\('\/vendor\/trtc-5\.19\.2\.mjs'\)/);
  assert.doesNotMatch(source, /aiTranscribe|speechSynthesis\.speak|aiActionConfirm|contactRequest/);
});

test('hangup releases tracks immediately and prevents another start until its response settles', async () => {
  const pending = deferred();
  const f = fixture({ request: (action, data, opts, normal) => action === 'aiRealtimeStop' ? pending.promise : normal(action) });
  await f.client.start(); const stopping = f.client.stop();
  assert.ok(f.tracks[0].stops); assert.equal(f.states.at(-1).phase, 'stopping');
  await f.client.start(); await f.client.stop(); assert.equal(f.acquisitions(), 1);
  pending.resolve({ status: 'stopping' }); await stopping;
  assert.equal(f.states.at(-1).phase, 'stop-pending'); assert.match(f.states.at(-1).message, /尚未确认/);
  await f.client.start(); assert.equal(f.acquisitions(), 1); assert.equal(f.client.busy(), true);
});

test('device errors explain recovery without exposing service configuration and never allocate a task', async () => {
  for (const [name, hint] of [['NotFoundError', /没有找到麦克风/], ['NotReadableError', /其他应用占用/]]) {
    const f = fixture({ acquire: () => Promise.reject(Object.assign(Error('private configuration detail'), { name })) });
    await f.client.start(); assert.match(f.states.at(-1).message, hint);
    assert.doesNotMatch(f.states.at(-1).message, /configuration|服务配置/); assert.equal(f.calls.length, 0);
  }
});

test('local publishing waits for the expected robot audio and waiting can be muted', async () => {
  const f = fixture(); await f.client.start();
  assert.equal(f.states.at(-1).phase, 'waiting'); assert.match(f.states.at(-1).message, /麦克风已开启/);
  f.instances[0].events.audio({ userId: 'stranger' }); await settle();
  assert.equal(f.states.at(-1).phase, 'waiting');
  await f.client.mute(); assert.equal(f.tracks[0].enabled, false); assert.equal(f.states.at(-1).phase, 'waiting');
  f.instances[0].events.audio({ userId: 'bot' }); await settle();
  assert.equal(f.states.at(-1).phase, 'connected'); assert.equal(f.states.at(-1).muted, true);
  assert.equal([...f.timers.values()].some(t => t.ms === 30000), false);
  await f.client.stop();
});

test('missing robot audio times out with no false connected state or automatic restart', async () => {
  const f = fixture(); await f.client.start();
  await [...f.timers.values()].find(t => t.ms === 30000).fn(); await settle();
  assert.equal(f.states.some(s => s.phase === 'connected'), false);
  assert.ok(f.tracks[0].stops); assert.equal(f.timers.size, 0); assert.equal(f.acquisitions(), 1);
  f.instances[0].events.audio({ userId: 'bot' }); await settle();
  assert.equal(f.states.at(-1).phase, 'idle');
});

test('lease heartbeat is scheduled before slow room entry and is removed on stop', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ enter: () => { entered.resolve(); return gate.promise; } });
  const starting = f.client.start(); await entered.promise;
  const [timerId, timer] = [...f.timers.entries()].find(([, t]) => t.ms === 10000); f.timers.delete(timerId); await timer.fn();
  assert.ok(f.calls.some(c => c.action === 'aiRealtimeStatus'));
  await f.client.stop(); gate.resolve(); await starting;
  assert.equal(f.timers.size, 0); assert.equal(f.instances[0].publishes, 0);
});

test('failed hangup survives a replacement panel client and retries the same ID before starting', async () => {
  const stopState = {};
  const first = fixture({ stopState, request: (action, data, opts, normal) => { if (action === 'aiRealtimeStop') throw Error('offline'); return normal(action); } });
  await first.client.start(); await first.client.stop();
  assert.equal(first.states.at(-1).phase, 'stop-pending'); assert.ok(first.tracks[0].stops);
  const next = fixture({ stopState }); await next.client.start();
  assert.equal(next.acquisitions(), 0); assert.equal(next.client.pending(), true);
  await next.client.stop();
  assert.equal(next.calls[0].data.requestId, first.calls[0].data.requestId);
  assert.equal(next.client.pending(), false); assert.equal(next.states.at(-1).phase, 'idle');
  await next.client.start(); assert.equal(next.acquisitions(), 1); await next.client.stop();
});

test('replacement panel receives late stop confirmation or failure from the shared pending request', async () => {
  for (const fails of [false, true]) {
    const gate = deferred(), stopState = {};
    const first = fixture({ stopState, request: (action, data, opts, normal) => action === 'aiRealtimeStop' ? gate.promise : normal(action) });
    await first.client.start(); const ending = first.client.stop(); first.client.detach();
    const next = fixture({ stopState }); await next.client.start(); await next.client.stop();
    assert.equal(next.calls.length, 0); assert.equal(next.acquisitions(), 0);
    if (fails) gate.reject(Error('network')); else gate.resolve({ status: 'ended' });
    await ending;
    assert.equal(next.states.at(-1).phase, fails ? 'stop-pending' : 'idle');
    assert.equal(next.client.busy(), fails);
    if (fails) await next.client.stop();
  }
});
