'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server/public/family-call.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

// Controlled DOM/media doubles validate signalling and ownership only. No browser,
// microphone, TURN allocation or actual RTP audio is exercised by these tests.
function fixture(options = {}) {
  const requests = [], peers = [], streams = [], timers = new Map(), documentEvents = {}, windowEvents = {}, plays = [];
  let sequence = 0, microphoneCalls = 0, aiPauses = 0, reminders = 0, clockOffset = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.listeners = {}; this.id = ''; this.value = ''; this.disabled = false; this.hidden = false; this.open = false; this._text = ''; this.srcObject = null; this.paused = true; }
    get isConnected() { return this === body || Boolean(this.parent?.isConnected); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
    set innerHTML(html) {
      this.replaceChildren(); const stack = [this];
      for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
        if (token.startsWith('</')) { stack.pop(); continue; }
        if (token.startsWith('<')) { const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue; const item = new Element(tag);
          for (const attr of token.matchAll(/([\w-]+)="([^"]*)"/g)) item.setAttribute(attr[1], attr[2]);
          if (/\bhidden\b/.test(token)) item.hidden = true; stack.at(-1).append(item); if (!['input', 'img', 'br'].includes(tag)) stack.push(item);
        } else { const item = new Element('#text'); item._text = token; stack.at(-1).append(item); }
      }
    }
    append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...items); }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; } }
    querySelectorAll(selector) { const found = []; const visit = item => { for (const child of item.children) { if (selector.startsWith('#') ? child.id === selector.slice(1) : child.tagName === selector) found.push(child); visit(child); } }; visit(this); return found; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    showModal() { this.open = true; }
    close() { const wasOpen = this.open; this.open = false; if (wasOpen) this.listeners.close?.(); }
    click() { if (this.isConnected && !this.disabled && !this.hidden) return this.onclick?.({ preventDefault() {} }); }
    pause() { this.paused = true; }
    play() { plays.push(this); if (options.failPlayback) return Promise.reject(new Error('autoplay blocked')); this.paused = false; return options.play ? options.play(this) : Promise.resolve(); }
  }
  const body = new Element('body');
  const document = { body, hidden: false, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), addEventListener: (event, fn) => { documentEvents[event] = fn; } };
  const track = (kind = 'audio') => ({ kind, readyState: 'live', stops: 0, onended: null, stop() { this.stops++; this.readyState = 'ended'; } });
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; streams.push(this); }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(item => item.kind === 'audio'); }
    addTrack(item) { this.tracks.push(item); }
  }
  class Peer {
    constructor(config) { this.config = clone(config); this.connectionState = 'new'; this.localDescription = null; this.remoteDescription = null; this.localTracks = []; this.addedCandidates = []; this.closes = 0; peers.push(this); }
    addTrack(item) { this.localTracks.push(item); }
    close() { this.closes++; this.connectionState = 'closed'; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
    async setLocalDescription(value) { this.localDescription = clone(value); }
    async setRemoteDescription(value) { this.remoteDescription = clone(value); }
    async addIceCandidate(value) { this.addedCandidates.push(clone(value)); }
  }
  const server = { enabled: options.enabled !== false, call: null, reason: '尚未配置家庭通话 TURN 中继。', peer: null, requestId: '', cancelled: new Set() };
  const capabilities = () => ({ enabled: server.enabled, audioCall: server.enabled, reason: server.reason, pollIntervalMs: 1500, maxCandidates: 48, iceTransportPolicy: 'relay' });
  const members = [{ id: 'member-b', name: '家人乙', role: 'family' }];
  const makeCall = (values = {}) => ({ id: 'call-one', from: { id: 'member-a', name: '家人甲' }, to: members[0], direction: 'outgoing', status: 'ringing', revision: 1, canControl: true, ringExpiresAt: Date.now() + 60000, expiresAt: Date.now() + 900000, ...values });
  const normal = request => {
    const { action, data } = request;
    if (action === 'callState') return { capabilities: capabilities(), members, calls: server.call ? [clone(server.call)] : [], ...(data.id ? { call: { ...clone(server.call), peer: server.peer } } : {}), serverTime: Date.now() };
    if (action === 'callStart') { if (server.cancelled.has(data.requestId)) throw Object.assign(new Error('start cancelled'), { status: 409 }); server.call = makeCall(); server.requestId = data.requestId; }
    if (action === 'callCancelStart') {
      server.cancelled.add(data.requestId);
      if (server.requestId === data.requestId && server.call) server.call = { ...server.call, status: 'ended', revision: server.call.revision + 1 };
      return { cancelled: true, callId: server.requestId === data.requestId ? server.call?.id : null, serverTime: Date.now() };
    }
    if (action === 'callAccept') server.call = { ...server.call, status: 'accepted', revision: server.call.revision + 1, canControl: true };
    if (action === 'callReject') server.call = { ...server.call, status: server.call.status === 'ringing' ? 'declined' : 'ended', revision: server.call.revision + 1 };
    if (action === 'callEnd') { if (server.call?.id === data.id) server.call = { ...server.call, status: 'ended', revision: server.call.revision + 1 }; }
    if (action === 'callIce') return { iceTransportPolicy: 'relay', iceServers: [{ urls: ['turn:relay.example.test:3478'], username: 'ephemeral-test', credential: 'test-only' }], expiresAt: Date.now() + 960000 };
    return { callId: server.call?.id || data.id, call: server.call && { ...clone(server.call), peer: server.peer }, serverTime: Date.now() };
  };
  const context = vm.createContext({
    document, navigator: { mediaDevices: { getUserMedia: () => { microphoneCalls++; return options.microphone ? options.microphone() : Promise.resolve(new Stream([track()])); } } },
    isSecureContext: options.secure !== false, RTCPeerConnection: options.rtc === false ? undefined : Peer, MediaStream: Stream, AbortController,
    Date: class extends Date { static now() { return Date.now() + clockOffset; } },
    session: { token: 'account-a' }, sessionExpired: false, recording: null,
    MemoryAI: { pauseForCall() { aiPauses++; } }, MemoryContact: { open() { reminders++; } }, crypto: { randomUUID: () => `request-${++sequence}` },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener: (event, fn) => { windowEvents[event] = fn; },
    api: async (action, data, token, input) => { const request = { action, data: clone(data), token, signal: input?.signal }; requests.push(request); return options.api ? options.api(request, normal) : normal(request); }
  });
  vm.runInContext(source, context, { filename: 'family-call.js' });
  const $ = id => document.querySelector('#' + id), callRequests = action => requests.filter(item => item.action === action);
  async function dial() { await context.MemoryCall.open('member-b'); await $('callStart').click(); await settle(); }
  async function acceptOutgoing() { await dial(); server.call = { ...server.call, status: 'accepted', revision: 2 }; await context.MemoryCall.refresh(true); await settle(); }
  return { context, server, document, documentEvents, windowEvents, requests, peers, streams, timers, plays, track, Stream, makeCall, $, callRequests, dial, acceptOutgoing,
    microphoneCalls: () => microphoneCalls, aiPauses: () => aiPauses, reminders: () => reminders, advance: ms => { clockOffset += ms; } };
}

test('unconfigured real calls stay disabled with a reason and offer a reminder without sending one', async () => {
  const f = fixture({ enabled: false }); await f.context.MemoryCall.open('member-b');
  assert.match(f.$('callCapability').textContent, /TURN/); assert.equal(f.$('callStart').disabled, true);
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.peers.length, 0); assert.equal(f.context.MemoryCall.supported(), true);
  f.$('callReminder').click(); assert.equal(f.reminders(), 1); assert.equal(f.callRequests('callStart').length, 0);
  assert.equal(f.$('familyCallDialog').open, false);
});

test('caller rings only after explicit confirmation and opens no microphone before acceptance', async () => {
  const f = fixture(); await f.context.MemoryCall.open('member-b');
  assert.equal(f.callRequests('callStart').length, 0); await f.$('callStart').click();
  assert.equal(f.callRequests('callStart').length, 1); assert.equal(f.microphoneCalls(), 0); assert.equal(f.peers.length, 0);
  assert.match(f.$('callContent').textContent, /等待家人主动接听/);
  assert.equal(f.$('callClose').textContent, '挂断并关闭');
});

test('accepted call pauses the frame player even when it is not attached to the DOM', async () => {
  const f = fixture(); let pauses = 0;
  f.context.frameAudio = { pause() { pauses++; } };
  await f.dial(); assert.equal(pauses, 0); assert.equal(f.microphoneCalls(), 0);
  f.server.call = { ...f.server.call, status: 'accepted', revision: 2 };
  await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(pauses, 1); assert.equal(f.microphoneCalls(), 1);
});

test('incoming ringing never opens a microphone until the recipient actively accepts', async () => {
  const f = fixture(); f.server.call = f.makeCall({ direction: 'incoming' }); await f.context.MemoryCall.refresh(true);
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.$('familyCallNotice').hidden, false);
  await f.$('familyCallNotice').click(); await f.$('callAccept').click(); await settle();
  assert.equal(f.callRequests('callAccept').length, 1); assert.equal(f.microphoneCalls(), 1); assert.equal(f.aiPauses(), 1);
  assert.equal(f.peers[0].config.iceTransportPolicy, 'relay');
  assert.equal(f.callRequests('callSignal').length, 0, 'callee waits for the caller offer');
});

test('an existing family voice draft blocks both starting and accepting without destroying the draft', async () => {
  const f = fixture(); f.context.recording = { draft: true }; await f.context.MemoryCall.open('member-b'); await f.$('callStart').click();
  assert.equal(f.callRequests('callStart').length, 0); assert.match(f.$('callStatus').textContent, /先结束/);
  f.server.call = f.makeCall({ direction: 'incoming' }); await f.context.MemoryCall.refresh(true); await f.$('callAccept').click();
  assert.equal(f.callRequests('callAccept').length, 0); assert.equal(f.microphoneCalls(), 0); assert.equal(f.context.recording.draft, true);
});

test('acceptance and a connected peer do not claim audible audio until a remote track plays successfully', async () => {
  const options = { failPlayback: true }, f = fixture(options); await f.acceptOutgoing();
  const pc = f.peers[0]; assert.equal(f.microphoneCalls(), 1); assert.equal(f.callRequests('callSignal')[0].data.description.type, 'offer');
  pc.connectionState = 'connected'; pc.onconnectionstatechange(); assert.doesNotMatch(f.$('callStatus').textContent, /语音已连接/);
  const remote = f.track(); pc.ontrack({ track: remote }); await settle();
  assert.match(f.$('callStatus').textContent, /尚未播放/); assert.equal(f.$('callListen').hidden, false);
  options.failPlayback = false; await f.$('callListen').click();
  assert.match(f.$('callStatus').textContent, /语音已连接/); assert.equal(f.$('callListen').hidden, true);
  assert.equal(f.callRequests('callSignal').some(item => item.data.status === 'connected'), false);
});

test('hangup releases tracks, peer, media element, timers and handlers and sends a bound end request', async () => {
  const f = fixture(); await f.acceptOutgoing(); const pc = f.peers[0], remote = f.track(); pc.ontrack({ track: remote }); await settle();
  const audio = f.document.querySelector('audio'), local = pc.localTracks[0]; f.$('callHangup').click(); await settle();
  assert.equal(local.readyState, 'ended'); assert.equal(remote.readyState, 'ended'); assert.equal(pc.closes, 1);
  assert.equal(pc.ontrack, null); assert.equal(pc.onicecandidate, null); assert.equal(audio.srcObject, null); assert.equal(audio.paused, true);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.callRequests('callEnd')[0].data, { id: 'call-one', reason: 'hangup' });
});

test('closing while microphone permission is pending stops a late stream without constructing a peer', async () => {
  const permission = deferred(), f = fixture({ microphone: () => permission.promise }); await f.acceptOutgoing();
  f.$('callClose').click(); const late = new f.Stream([f.track()]); permission.resolve(late); await settle();
  assert.equal(late.getTracks()[0].readyState, 'ended'); assert.equal(f.peers.length, 0); assert.equal(f.$('familyCallDialog').open, false);
  assert.equal(f.timers.size, 0);
});

test('page hiding and identity replacement release an established microphone immediately', async () => {
  const f = fixture(); await f.acceptOutgoing(); const pc = f.peers[0];
  f.document.hidden = true; f.documentEvents.visibilitychange(); await settle();
  assert.equal(pc.localTracks[0].readyState, 'ended'); assert.equal(pc.closes, 1); assert.equal(f.timers.size, 0);
  f.document.hidden = false; f.context.session = { token: 'account-b' }; f.server.call = null; await f.context.MemoryCall.refresh(true);
  assert.equal(f.callRequests('callState').at(-1).token, 'account-b'); assert.equal(f.microphoneCalls(), 1);
});

test('the other device of an already-answered account cannot acquire microphone or TURN credentials', async () => {
  const f = fixture(); f.server.call = f.makeCall({ direction: 'incoming', status: 'accepted', canControl: false });
  await f.context.MemoryCall.open(); await settle();
  assert.equal(f.callRequests('callIce').length, 0); assert.equal(f.microphoneCalls(), 0); assert.match(f.$('callContent').textContent, /另一台设备/);
});

test('callee applies one offer, answers once and deduplicates remote trickle ICE by sequence', async () => {
  const f = fixture(); f.server.call = f.makeCall({ direction: 'incoming' }); await f.context.MemoryCall.open(); await f.$('callAccept').click(); await settle();
  const candidate = { candidate: 'candidate:1 1 UDP 1 192.0.2.1 50000 typ relay', sdpMid: '0', sdpMLineIndex: 0 };
  f.server.peer = { description: { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }, candidates: [{ seq: 1, candidate }], iceComplete: true };
  await f.context.MemoryCall.refresh(true); await settle(); await f.context.MemoryCall.refresh(true);
  assert.equal(f.callRequests('callSignal').filter(item => item.data.description?.type === 'answer').length, 1);
  assert.deepEqual(f.peers[0].addedCandidates, [candidate, null]);
});

test('local ICE is sent in bounded batches only after the local description and includes completion', async () => {
  const f = fixture(); await f.acceptOutgoing(); const pc = f.peers[0];
  for (let i = 0; i < 10; i++) pc.onicecandidate({ candidate: { candidate: `candidate:${i} 1 UDP 1 192.0.2.1 ${50000 + i} typ relay`, sdpMid: '0', sdpMLineIndex: 0 } });
  pc.onicecandidate({ candidate: null }); const timer = [...f.timers.values()].find(item => item.ms === 50); timer.fn(); await settle();
  const signals = f.callRequests('callSignal'); assert.equal(signals[0].data.description.type, 'offer');
  assert.deepEqual(signals.filter(item => item.data.candidates).map(item => item.data.candidates.length), [8, 2]);
  assert.equal(signals.at(-1).data.iceComplete, true);
});

test('a missing microphone permission or failed connection ends the call without claiming connection', async () => {
  const f = fixture({ microphone: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) }); await f.acceptOutgoing();
  assert.match(f.$('callStatus').textContent, /未获允许/); assert.equal(f.peers.length, 0); assert.equal(f.callRequests('callEnd')[0].data.reason, 'failed');
  const second = fixture(); await second.acceptOutgoing(); const pc = second.peers[0]; pc.connectionState = 'failed'; pc.onconnectionstatechange(); await settle();
  assert.equal(pc.localTracks[0].readyState, 'ended'); assert.doesNotMatch(second.$('callStatus').textContent, /语音已连接/);
});

test('turning the feature off or reaching the local connection deadline releases active capture', async () => {
  const f = fixture(); await f.acceptOutgoing(); f.server.enabled = false; await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(f.peers[0].localTracks[0].readyState, 'ended'); assert.match(f.$('callCapability').textContent, /TURN/);
  const second = fixture(); await second.acceptOutgoing(); [...second.timers.values()].find(item => item.ms === 45000).fn(); await settle();
  assert.equal(second.peers[0].localTracks[0].readyState, 'ended'); assert.match(second.$('callStatus').textContent, /超时/);
});

test('an unsupported browser terminates an already-confirmed AI call instead of leaving it ringing', async () => {
  const f = fixture({ rtc: false }); await f.context.MemoryCall.start('member-b', { callId: 'already-confirmed' }); await settle();
  assert.equal(f.context.MemoryCall.supported(), false); assert.equal(f.callRequests('callStart').length, 0);
  assert.deepEqual(f.callRequests('callEnd')[0].data, { id: 'already-confirmed', reason: 'failed' }); assert.equal(f.microphoneCalls(), 0);
});

test('a late call-start result after closing is ended without reopening or acquiring microphone', async () => {
  const delayed = deferred(), f = fixture({ api: (request, normal) => request.action === 'callStart' ? delayed.promise : normal(request) });
  await f.context.MemoryCall.open('member-b'); const starting = f.$('callStart').click(); f.$('callClose').click(); await starting;
  delayed.resolve({ callId: 'late-call', call: f.makeCall({ id: 'late-call' }), serverTime: Date.now() }); await settle();
  assert.equal(f.$('familyCallDialog').open, false); assert.equal(f.microphoneCalls(), 0);
  assert.equal(f.callRequests('callEnd')[0].data.id, 'late-call');
});

test('closing a ringing incoming call explicitly rejects it even before this device owns a media endpoint', async () => {
  const f = fixture(); f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
  f.$('callClose').click(); await settle();
  assert.deepEqual(f.callRequests('callReject')[0].data, { id: 'call-one' });
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.$('familyCallDialog').open, false);
});

test('a late acceptance after closing ends the newly bound call and never requests a microphone', async () => {
  const accepted = deferred(), f = fixture({ api: (request, normal) => request.action === 'callAccept' ? accepted.promise : normal(request) });
  f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
  const accepting = f.$('callAccept').click(); f.$('callClose').click(); await accepting;
  accepted.resolve({ callId: 'call-one', call: f.makeCall({ direction: 'incoming', status: 'accepted', canControl: true }), serverTime: Date.now() }); await settle();
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.callRequests('callEnd').at(-1).data.reason, 'cancelled');
  assert.equal(f.timers.size, 0);
});

test('state synchronisation timeout ends active capture even when an API promise ignores abort', async () => {
  let hang = false;
  const f = fixture({ api: (request, normal) => hang && request.action === 'callState' ? new Promise(() => {}) : normal(request) });
  await f.acceptOutgoing(); hang = true; const checking = f.context.MemoryCall.refresh(true); await settle();
  [...f.timers.values()].find(item => item.ms === 12000).fn(); await checking; await settle();
  assert.equal(f.peers[0].localTracks[0].readyState, 'ended'); assert.match(f.$('callStatus').textContent, /状态同步失败/);
  assert.equal(f.callRequests('callState').at(-1).signal.aborted, true); assert.equal(f.timers.size, 0);
});

test('closing cancels by stable request id when callStart committed but fetch abort loses its response', async () => {
  const f = fixture({ api: (request, normal) => {
    if (request.action !== 'callStart') return normal(request);
    normal(request); // The server commits first; a browser fetch abort then hides that response.
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('fetch aborted'), { name: 'AbortError' })), { once: true }));
  } });
  await f.context.MemoryCall.open('member-b'); const starting = f.$('callStart').click(); await settle();
  assert.equal(f.server.call.status, 'ringing'); f.$('callClose').click(); await starting; await settle();
  assert.deepEqual(f.callRequests('callCancelStart')[0].data, { requestId: f.callRequests('callStart')[0].data.requestId });
  assert.equal(f.server.call.status, 'ended'); await f.context.MemoryCall.refresh(true);
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.$('familyCallDialog').open, false);
});

test('failed start cancellation is retried and closed background recovery never obtains microphone', async () => {
  let cancellationOnline = false;
  const f = fixture({ api: (request, normal) => {
    if (request.action === 'callCancelStart' && !cancellationOnline) throw Error('offline');
    if (request.action !== 'callStart') return normal(request);
    normal(request); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('fetch aborted'), { name: 'AbortError' })), { once: true }));
  } });
  await f.context.MemoryCall.open('member-b'); const starting = f.$('callStart').click(); await settle();
  f.$('callClose').click(); await starting; await settle();
  await f.context.MemoryCall.refresh(true); f.server.call.status = 'accepted'; await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.callRequests('callIce').length, 0); assert.equal(f.$('familyCallDialog').open, false);
  cancellationOnline = true; await f.context.MemoryCall.refresh(true);
  assert.equal(f.server.call.status, 'ended');
  assert.ok(f.callRequests('callCancelStart').length >= 2);
  assert.equal(new Set(f.callRequests('callCancelStart').map(item => item.data.requestId)).size, 1);
});

test('recovered accepted calls require a visible explicit resume action before acquiring audio', async () => {
  const f = fixture(); f.server.call = f.makeCall({ status: 'accepted' });
  await f.context.MemoryCall.refresh(true); await settle(); assert.equal(f.microphoneCalls(), 0);
  await f.context.MemoryCall.open(); await settle(); assert.equal(f.microphoneCalls(), 0);
  assert.ok(f.$('callResume')); f.$('callResume').click(); await settle();
  assert.equal(f.microphoneCalls(), 1);
});

test('an empty ICE candidate is generation completion, never an invalid candidate upload', async () => {
  const f = fixture(); await f.acceptOutgoing();
  f.peers[0].onicecandidate({ candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0 } });
  [...f.timers.values()].find(item => item.ms === 50).fn(); await settle();
  const signals = f.callRequests('callSignal'); assert.equal(signals.at(-1).data.iceComplete, true);
  assert.equal(signals.some(item => item.data.candidates?.some(candidate => candidate.candidate === '')), false);
  assert.equal(f.callRequests('callEnd').length, 0); assert.equal(f.peers[0].localTracks[0].readyState, 'live');
});

test('closing an AI-confirmed call while its initial state loads terminates that known call id', async () => {
  const delayed = deferred();
  const f = fixture({ api: (request, normal) => request.action === 'callState' ? delayed.promise : normal(request) });
  const starting = f.context.MemoryCall.start('member-b', { callId: 'confirmed-ai-call' });
  f.$('callClose').click(); await starting; await settle();
  assert.deepEqual(f.callRequests('callEnd')[0].data, { id: 'confirmed-ai-call', reason: 'cancelled' });
  delayed.resolve({ capabilities: { enabled: true }, calls: [f.makeCall({ id: 'confirmed-ai-call', status: 'accepted' })], members: [] }); await settle();
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.$('familyCallDialog').open, false);
});

test('changing the recipient cancels an uncertain start before discarding its stable request id', async () => {
  const cancelled = deferred(); let cancellation;
  const f = fixture({ api: (request, normal) => {
    if (request.action === 'callStart') { normal(request); throw Error('response lost'); }
    if (request.action === 'callCancelStart') { cancellation = normal(request); return cancelled.promise; }
    return normal(request);
  } });
  await f.dial(); assert.equal(f.server.call.status, 'ringing');
  f.$('callRecipient').value = ''; f.$('callRecipient').onchange();
  assert.equal(f.server.call.status, 'ended');
  assert.deepEqual(f.callRequests('callCancelStart')[0].data, { requestId: f.callRequests('callStart')[0].data.requestId });
  f.$('callRecipient').value = 'member-b'; f.$('callRecipient').onchange(); await f.$('callStart').click();
  assert.equal(f.callRequests('callStart').length, 1); assert.match(f.$('callStatus').textContent, /取消仍待服务器确认/);
  cancelled.resolve(cancellation); await settle(); assert.equal(f.microphoneCalls(), 0);
});

test('closing after a committed acceptance with an aborted fetch rejects the exact accepted endpoint', async () => {
  const f = fixture({ api: (request, normal) => {
    if (request.action !== 'callAccept') return normal(request);
    normal(request);
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('fetch aborted'), { name: 'AbortError' })), { once: true }));
  } });
  f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
  const accepting = f.$('callAccept').click(); await settle(); assert.equal(f.server.call.status, 'accepted');
  f.$('callClose').click(); await accepting; await settle();
  assert.deepEqual(f.callRequests('callReject')[0].data, { id: 'call-one' }); assert.equal(f.server.call.status, 'ended');
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), false); assert.equal(f.microphoneCalls(), 0);
});

test('failed termination of an accepted call remains pending and retries after authenticated refresh', async () => {
  let online = false;
  const f = fixture({ api: (request, normal) => {
    if (request.action === 'callReject' && !online) throw Error('network down');
    if (request.action !== 'callAccept') return normal(request);
    normal(request); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  } });
  f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
  const accepting = f.$('callAccept').click(); await settle(); f.$('callClose').click(); await accepting; await settle();
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), true); assert.equal(f.server.call.status, 'accepted');
  assert.match(f.$('callStatus').textContent, /服务器尚未确认/); assert.equal(f.microphoneCalls(), 0);
  online = true; await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(f.server.call.status, 'ended'); assert.equal(f.context.MemoryCall.hasPendingCancellations(), false);
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.$('familyCallDialog').open, false);
  assert.ok(f.callRequests('callReject').length >= 2);
});

test('a successful HTTP end response is still pending until the matching call is terminal', async () => {
  let terminal = false;
  const f = fixture({ api: (request, normal) => request.action === 'callEnd' && !terminal
    ? { callId: request.data.id, call: { id: request.data.id, status: 'connecting' } }
    : normal(request) });
  await f.acceptOutgoing(); f.$('callHangup').click(); await settle();
  assert.equal(f.peers[0].localTracks[0].readyState, 'ended'); assert.equal(f.context.MemoryCall.hasPendingCancellations(), true);
  assert.match(f.$('callStatus').textContent, /尚未确认/);
  terminal = true; await f.context.MemoryCall.refresh(true);
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), false); assert.equal(f.server.call.status, 'ended');
});

test('a hidden AI call result never opens a dialog or acquires media and its failed end retries on return', async () => {
  let online = false;
  const f = fixture({ api: (request, normal) => { if (request.action === 'callEnd' && !online) throw Error('offline'); return normal(request); } });
  f.server.call = f.makeCall({ id: 'hidden-ai-call', status: 'accepted' }); f.document.hidden = true;
  await f.context.MemoryCall.start('member-b', { callId: 'hidden-ai-call' }); await settle();
  assert.equal(f.$('familyCallDialog'), null); assert.equal(f.microphoneCalls(), 0); assert.equal(f.context.MemoryCall.hasPendingCancellations(), true);
  f.document.hidden = false; online = true; await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(f.server.call.status, 'ended'); assert.equal(f.context.MemoryCall.hasPendingCancellations(), false);
  assert.equal(f.$('familyCallDialog').open, false); assert.equal(f.callRequests('callIce').length, 0);
});

test('hiding while an AI call initial state loads retains a failed termination for later retry', async () => {
  const loading = deferred(); let online = false, firstState = true;
  const f = fixture({ api: (request, normal) => {
    if (request.action === 'callState' && firstState) { firstState = false; return loading.promise; }
    if (request.action === 'callEnd' && !online) throw Error('offline');
    return normal(request);
  } });
  f.server.call = f.makeCall({ id: 'loading-ai-call', status: 'accepted' });
  const starting = f.context.MemoryCall.start('member-b', { callId: 'loading-ai-call' }); await settle();
  f.document.hidden = true; f.documentEvents.visibilitychange(); await starting; await settle();
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), true); assert.equal(f.microphoneCalls(), 0);
  online = true; f.document.hidden = false; await f.context.MemoryCall.refresh(true);
  assert.equal(f.server.call.status, 'ended'); assert.equal(f.$('familyCallDialog').open, false);
  loading.resolve({ capabilities: { enabled: true }, calls: [f.makeCall({ id: 'loading-ai-call', status: 'accepted' })], members: [] }); await settle();
  assert.equal(f.microphoneCalls(), 0);
});

test('public pre-result cancellation binds the supplied original token and remains bounded to 20 entries and 24 hours', async () => {
  const f = fixture({ api: (request, normal) => { if (request.action === 'callCancelStart') throw Error('offline'); return normal(request); } });
  f.context.session = { token: 'new-account' };
  for (let i = 0; i < 20; i++) assert.equal(f.context.MemoryCall.cancelStart(`aic-request-${i}`, 'original-account'), true);
  assert.equal(f.context.MemoryCall.cancelStart('aic-over-limit', 'original-account'), false); await settle();
  assert.equal(f.context.MemoryCall.hasPendingCancellations('original-account'), true); assert.equal(f.context.MemoryCall.hasPendingCancellations(), false);
  assert.equal(f.context.MemoryCall.canStart(), false, 'a full global termination queue leaves no safe cancellation slot');
  assert.ok(f.callRequests('callCancelStart').length > 0);
  assert.ok(f.callRequests('callCancelStart').every(request => request.token === 'original-account'));
  f.advance(86400001); assert.equal(f.context.MemoryCall.hasPendingCancellations('original-account'), false);
  assert.equal(f.context.MemoryCall.canStart(), true);
  assert.equal(f.context.MemoryCall.cancelStart('short', 'original-account'), false);
});

test('pending cancellation blocks new direct calls, incoming acceptance and explicit media recovery', async () => {
  const f = fixture({ api: (request, normal) => { if (request.action === 'callCancelStart') throw Error('offline'); return normal(request); } });
  await f.context.MemoryCall.open('member-b'); f.context.MemoryCall.cancelStart('aic-pending-call'); await settle();
  assert.equal(f.context.MemoryCall.canStart(), false); await f.$('callStart').click(); assert.equal(f.callRequests('callStart').length, 0);
  f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.refresh(true);
  await f.$('callAccept').click(); assert.equal(f.callRequests('callAccept').length, 0);
  f.server.call = f.makeCall({ direction: 'incoming', status: 'accepted', canControl: true, revision: 2 }); await f.context.MemoryCall.refresh(true);
  f.$('callResume').click(); await settle(); assert.equal(f.microphoneCalls(), 0); assert.match(f.$('callStatus').textContent, /待服务器确认/);
});

test('a reject conflict clears only this device intent after authenticated proof that another device accepted', async () => {
  const f = fixture({ api: (request, normal) => { if (request.action === 'callReject') throw Object.assign(new Error('other device accepted'), { status: 409 }); return normal(request); } });
  f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
  f.server.call = { ...f.server.call, status: 'accepted', revision: 2 }; f.$('callClose').click(); await settle();
  const proof = f.callRequests('callState').at(-1);
  assert.deepEqual(proof.data, { id: 'call-one' }); assert.equal(proof.token, 'account-a');
  assert.equal(f.server.call.status, 'accepted'); assert.equal(f.callRequests('callEnd').length, 0);
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), false); assert.equal(f.context.MemoryCall.canStart(), true);
  assert.match(f.$('callStatus').textContent, /另一设备接听/); assert.doesNotMatch(f.$('callStatus').textContent, /服务器已确认呼叫结束/);
  assert.equal(f.microphoneCalls(), 0);
});

test('a reject permission error can clear after matching authenticated state proves the other device already ended', async () => {
  const f = fixture({ api: (request, normal) => { if (request.action === 'callReject') throw Object.assign(new Error('not the accepting device'), { status: 403 }); return normal(request); } });
  f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
  f.server.call = { ...f.server.call, status: 'ended', revision: 3 }; f.$('callClose').click(); await settle();
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), false); assert.equal(f.context.MemoryCall.canStart(), true);
  assert.match(f.$('callStatus').textContent, /服务器已确认呼叫结束/); assert.equal(f.callRequests('callEnd').length, 0);
});

test('a reject conflict never clears pending intent on failed, mismatched or non-authoritative state proof', async () => {
  for (const scenario of ['query-error', 'wrong-id', 'outgoing', 'owned', 'ringing', 'server-error']) {
    let proof = false;
    const f = fixture({ api: (request, normal) => {
      if (request.action === 'callReject') { proof = true; throw Object.assign(new Error('reject failed'), { status: scenario === 'server-error' ? 500 : 409 }); }
      if (request.action === 'callState' && request.data.id && proof) {
        if (scenario === 'query-error') throw Error('state unavailable');
        return { call: { id: scenario === 'wrong-id' ? 'another-call' : 'call-one', direction: scenario === 'outgoing' ? 'outgoing' : 'incoming', canControl: scenario === 'owned', status: scenario === 'ringing' ? 'ringing' : 'accepted' } };
      }
      return normal(request);
    } });
    f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
    f.$('callClose').click(); await settle();
    assert.equal(f.context.MemoryCall.hasPendingCancellations(), true, scenario);
    assert.equal(f.context.MemoryCall.canStart(), false, scenario); assert.match(f.$('callStatus').textContent, /尚未确认/, scenario);
    assert.equal(f.callRequests('callEnd').length, 0, scenario);
    if (scenario === 'server-error') assert.equal(f.callRequests('callState').length, 1, '500 cannot trigger the special ownership proof path');
  }
});

test('reject ownership verification shares the original four-second deadline and cannot hang cleanup', async () => {
  const f = fixture({ api: (request, normal) => {
    if (request.action === 'callReject') throw Object.assign(new Error('conflict'), { status: 409 });
    if (request.action === 'callState' && request.data.id) return new Promise(() => {});
    return normal(request);
  } });
  f.server.call = f.makeCall({ direction: 'incoming', canControl: false }); await f.context.MemoryCall.open();
  f.$('callClose').click(); await settle();
  const timeouts = [...f.timers.values()].filter(timer => timer.ms === 4000); assert.equal(timeouts.length, 1);
  const proof = f.callRequests('callState').at(-1); timeouts[0].fn(); await settle();
  assert.equal(proof.signal.aborted, true); assert.equal(f.context.MemoryCall.hasPendingCancellations(), true);
  assert.equal(f.timers.size, 0); assert.equal(f.microphoneCalls(), 0);
});

test('pending family recording permission and active or stopping AI realtime block start, accept and resume', async () => {
  for (const blocked of ['recording-permission', 'realtime']) {
    const f = fixture();
    if (blocked === 'recording-permission') f.context.recordingStarting = true;
    else f.context.MemoryRealtime = { busy: () => true };
    await f.context.MemoryCall.open('member-b'); await f.$('callStart').click();
    assert.equal(f.callRequests('callStart').length, 0, blocked);
    f.server.call = f.makeCall({ direction: 'incoming', canControl: false });
    await f.context.MemoryCall.refresh(true); await f.$('callAccept').click();
    assert.equal(f.callRequests('callAccept').length, 0, blocked);
    f.server.call = f.makeCall({ direction: 'incoming', status: 'accepted', revision: 2 });
    await f.context.MemoryCall.refresh(true); await f.$('callResume').click(); await settle();
    assert.equal(f.callRequests('callIce').length, 0, blocked); assert.equal(f.microphoneCalls(), 0, blocked);
    assert.match(f.$('callStatus').textContent, /录音授权|AI 实时/);
  }
});

test('a media conflict appearing during ICE lookup prevents a later microphone request', async () => {
  const lookup = deferred(), f = fixture({ api: (request, normal) => request.action === 'callIce' ? lookup.promise : normal(request) });
  await f.acceptOutgoing(); f.context.recordingStarting = true;
  lookup.resolve({ iceTransportPolicy: 'relay', iceServers: [{ urls: 'turn:relay.example.test' }], expiresAt: Date.now() + 100000 }); await settle();
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.peers.length, 0);
  assert.equal(f.callRequests('callEnd')[0].data.reason, 'failed');
});

test('a media conflict during microphone permission stops the late stream before RTC creation', async () => {
  const permission = deferred(), f = fixture({ microphone: () => permission.promise }); await f.acceptOutgoing();
  f.context.MemoryRealtime = { busy: () => true }; const late = new f.Stream([f.track()]); permission.resolve(late); await settle();
  assert.equal(late.getTracks()[0].readyState, 'ended'); assert.equal(f.peers.length, 0);
  assert.equal(f.callRequests('callEnd')[0].data.reason, 'failed');
});

test('offline blocks new calling and immediately releases active capture while preserving end retry', async () => {
  let offline = false;
  const f = fixture({ api: (request, normal) => { if (offline && request.action === 'callEnd') throw Error('offline'); return normal(request); } });
  await f.acceptOutgoing(); const local = f.peers[0].localTracks[0];
  f.context.navigator.onLine = false; offline = true; f.windowEvents.offline(); await settle();
  assert.equal(local.readyState, 'ended'); assert.equal(f.peers[0].closes, 1);
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), true); assert.match(f.$('callStatus').textContent, /尚未确认/);
  offline = false; f.context.navigator.onLine = true; await f.context.MemoryCall.refresh(true);
  assert.equal(f.context.MemoryCall.hasPendingCancellations(), false); assert.equal(f.microphoneCalls(), 1);
  const blocked = fixture(); blocked.context.navigator.onLine = false;
  await blocked.context.MemoryCall.open('member-b'); await blocked.$('callStart').click();
  assert.equal(blocked.callRequests('callStart').length, 0); assert.match(blocked.$('callStatus').textContent, /网络已断开/);
});

test('offline during pending microphone permission disposes a late stream without reconnecting', async () => {
  const permission = deferred(), f = fixture({ microphone: () => permission.promise }); await f.acceptOutgoing();
  f.context.navigator.onLine = false; f.windowEvents.offline();
  const late = new f.Stream([f.track()]); permission.resolve(late); await settle();
  assert.equal(late.getTracks()[0].readyState, 'ended'); assert.equal(f.peers.length, 0);
  f.context.navigator.onLine = true; await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(f.microphoneCalls(), 1);
});

test('a permission failure while refreshing stops capture without trusting stale accepted state', async () => {
  let revoked = false;
  const f = fixture({ api: (request, normal) => {
    if (revoked) throw Object.assign(Error('session revoked'), { status: 401 });
    return normal(request);
  } });
  await f.acceptOutgoing(); revoked = true; await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(f.peers[0].localTracks[0].readyState, 'ended'); assert.equal(f.peers[0].closes, 1);
  assert.equal(f.microphoneCalls(), 1); assert.match(f.$('callStatus').textContent, /麦克风已关闭/);
});

test('an accepted state arriving after its remaining lifetime never starts microphone capture', async () => {
  const delayed = deferred(); let wait = false, snapshot;
  const f = fixture({ api: (request, normal) => {
    if (wait && request.action === 'callState') { snapshot = normal(request); return delayed.promise; }
    return normal(request);
  } });
  await f.dial();
  f.server.call = { ...f.server.call, status: 'accepted', revision: 2, expiresAt: Date.now() + 500 };
  wait = true; const pending = f.context.MemoryCall.refresh(true); await settle();
  f.advance(1000); delayed.resolve(snapshot); await pending; await settle();
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.peers.length, 0); assert.equal(f.callRequests('callIce').length, 0);
  assert.match(f.$('callStatus').textContent, /到期/); assert.equal(f.callRequests('callEnd').length, 1);
});
