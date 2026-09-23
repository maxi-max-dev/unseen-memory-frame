'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { LocalStore } = require('../server/store');
const { createActions, TTL } = require('../server/ai-actions');
const { createFamilyCall } = require('../server/family-call');
const scripts = ['ai-action-ui.js', 'ai-conversation.js'].map(name => ({ name, source: fs.readFileSync(path.join(__dirname, '../server/public', name), 'utf8') }));
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

// Small form/controller DOM double, not a browser rendering or media implementation.
function dom() {
  class Element {
    constructor(tag) {
      this.tagName = tag.toLowerCase(); this.children = []; this.parentNode = null; this.listeners = {};
      this.id = ''; this.value = ''; this.disabled = false; this.checked = false; this.open = false; this.hidden = false; this.pauses = 0; this.paused = false; this._text = '';
    }
    get isConnected() { return this === body || Boolean(this.parentNode?.isConnected); }
    get options() { return this.children.filter(child => child.tagName === 'option'); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    set innerHTML(html) {
      this.replaceChildren();
      const stack = [this];
      for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
        if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        if (token.startsWith('<')) {
          const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
          const child = new Element(tag);
          for (const attr of token.matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attr[1], attr[2]);
          stack.at(-1).append(child);
          if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)) stack.push(child);
        } else { const text = new Element('#text'); text._text = token; stack.at(-1).append(text); }
      }
    }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    after(child) { if (!this.parentNode) return; child.remove(); const parent = this.parentNode; child.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, child); }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
    setAttribute(key, value) { this[key] = value; }
    querySelectorAll(selector) {
      const found = [], match = item => selector.startsWith('#') ? item.id === selector.slice(1) : selector === 'input:checked' ? item.tagName === 'input' && item.checked : item.tagName === selector;
      function visit(item) { for (const child of item.children) { if (match(child)) found.push(child); visit(child); } }
      visit(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    pause() { this.pauses++; this.paused = true; }
    click() { if (!this.disabled && this.isConnected) return this.onclick?.({ preventDefault() {} }); }
  }
  const body = new Element('body'), listeners = {};
  const document = {
    body, hidden: false,
    createElement: tag => new Element(tag),
    createTextNode(text) { const result = new Element('#text'); result.textContent = text; return result; },
    querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector),
    addEventListener: (name, callback) => { const previous = listeners[name]; listeners[name] = event => { previous?.(event); callback(event); }; }
  };
  return { document, listeners };
}

function fixture(options = {}) {
  const { document, listeners } = dom(), calls = [], recorders = [], utterances = [], urls = [], revoked = [], windowEvents = {}, timers = new Map(), callStarts = [], callCancellations = [];
  let speechCancels = 0, polls = 0, sequence = 0, actionSequence = 0, timerSequence = 0, microphoneCalls = 0;
  const state = { messages: Array.from({ length: 5 }, (_, index) => ({ _id: `m_${index + 1}`, type: 'photo', image: `f_${index + 1}`, imageURL: `/media/${index + 1}`, title: `照片${index + 1}` })) };
  const defaultResponse = (action, data) => {
    if (action === 'aiCapabilities') return { text: true, vision: true, asr: true };
    if (action === 'aiChat') return { answer: `答：${data.text}`, imageUsed: data.readPhoto, action: null };
    if (action === 'aiTranscribe') return { text: '转写的原声' };
    if (action === 'contactState') return { members: [{ id: 'member-a', name: '小明', role: 'family' }, { id: 'member-b', name: '小明', role: 'family' }] };
    if (action === 'upload') return { id: 'voice-file' };
    if (action === 'aiActionPrepare') return { ...copy(data), actionId: data.actionId || `candidate-${++actionSequence}`, version: (data.version || 0) + 1, targetName: '小明', expiresAt: Date.now() + 600000, needs: [], status: 'ready', ...(data.mode === 'audio-call' ? { callRequestId: `call-request-${actionSequence}` } : {}) };
    if (action === 'aiActionConfirm') return { ...copy(data), kind: 'message', status: 'completed', completed: 1 };
    return {};
  };
  const context = vm.createContext({
    document, AbortController, Blob, state, session: { token: 'account-a' }, sessionExpired: false, recording: null, frame: false,
    setTimeout(fn, ms) { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    URL: { createObjectURL(value) { const url = `blob:test-${++sequence}`; urls.push({ url, value }); return url; }, revokeObjectURL: url => revoked.push(url) },
    addEventListener: (name, callback) => { const previous = windowEvents[name]; windowEvents[name] = event => { previous?.(event); callback(event); }; },
    api: async (action, data, token, requestOptions) => {
      const call = { action, data: copy(data), token, signal: requestOptions?.signal }; calls.push(call);
      return options.api ? options.api(call, defaultResponse) : defaultResponse(action, data);
    },
    MemoryVoice: { create(config) {
      const recorder = { config, cancels: 0, starts: 0, finishes: 0,
        start() { this.starts++; return options.startVoice ? options.startVoice(this) : Promise.resolve(true); },
        finish() { this.finishes++; return options.finishVoice ? options.finishVoice(this) : Promise.resolve(new Blob(['voice'], { type: 'audio/wav' })); },
        cancel() { this.cancels++; }
      };
      recorders.push(recorder); return recorder;
    } },
    MemoryCall: { supported: () => options.callSupported !== false, canStart: () => options.canStart !== false, start(targetId, data) { callStarts.push({ targetId, ...copy(data) }); }, cancelStart(requestId, token) { callCancellations.push({ requestId, token }); } },
    isSecureContext: true, RTCPeerConnection: class {},
    navigator: { mediaDevices: { getUserMedia: () => { microphoneCalls++; return Promise.reject(Error('Unexpected microphone acquisition')); } } },
    speechSynthesis: { cancel() { speechCancels++; }, getVoices: () => [{ lang: 'zh-CN' }], speak: utterance => utterances.push(utterance) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    base64: async () => 'encoded-voice', toast() {}, poll() { polls++; }
  });
  if (options.realCalls) vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/public/family-call.js'), 'utf8'), context, { filename: 'family-call.js' });
  if (options.realTime) vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/public/ai-realtime.js'), 'utf8'), context, { filename: 'ai-realtime.js' });
  for (const script of scripts) vm.runInContext(script.source, context, { filename: script.name });
  const $ = id => document.querySelector('#' + id);
  async function send(text) { $('aiQuestion').value = text; return $('aiForm').onsubmit({ preventDefault() {} }); }
  const actionCalls = action => calls.filter(call => call.action === action);
  async function suggest(suggestion = {}) {
    return context.MemoryActionUI.suggest({ container: $('aiAction'), token: context.session.token,
      suggestion: { kind: 'message', targetHint: '小明', text: '今晚一起吃饭', usePhotos: false, useVoice: false, ...suggestion }, messageIds: ['m_1', 'm_2'], voice: null });
  }
  return { context, document, listeners, windowEvents, calls, recorders, utterances, urls, revoked, timers, callStarts, callCancellations, $, send, suggest, actionCalls, defaultResponse, microphoneCalls: () => microphoneCalls, speechCancels: () => speechCancels, polls: () => polls };
}

test('real realtime panel stays explicitly unavailable without requesting microphone and returns to text chat', async () => {
  const f = fixture({ realTime: true, api: (call, normal) => call.action === 'aiRealtimeCapabilities' ? { enabled: false, provider: 'tencent-trtc', reason: '实时语音尚未开通' } : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.$('aiRealtimeEntry').click();
  assert.equal(f.$('aiQuestion'), null); assert.equal(f.$('realtimeStart').disabled, true);
  assert.match(f.$('realtimeAvailability').textContent, /尚未开通/); assert.equal(f.microphoneCalls(), 0);
  assert.equal(f.actionCalls('aiRealtimeStart').length, 0); assert.equal(f.actionCalls('aiTranscribe').length, 0);
  f.$('realtimeText').click(); await settle(); assert.ok(f.$('aiQuestion')); assert.equal(f.$('realtimeStart'), null);
  await f.send('今天想聊种菜'); assert.equal(f.actionCalls('aiChat').length, 1);
});

test('late realtime capability response cannot change a later text window or start microphone', async () => {
  const pending = deferred(); const f = fixture({ realTime: true, api: (call, normal) => call.action === 'aiRealtimeCapabilities' ? pending.promise : normal(call.action, call.data) });
  const opening = f.context.MemoryRealtime.open(); f.$('realtimeClose').click(); await f.context.MemoryAI.open();
  pending.resolve({ enabled: true, provider: 'tencent-trtc' }); await opening;
  assert.equal(f.$('realtimeStart'), null); assert.ok(f.$('aiQuestion')); assert.equal(f.microphoneCalls(), 0);
  assert.equal(f.actionCalls('aiRealtimeStart').length, 0);
});

test('switching to realtime preserves text draft, history and photos, while cancelling pending work and actions', async () => {
  const late = deferred();
  const f = fixture({ realTime: true, api: (call, normal) => call.action === 'aiChat' && call.data.text === '还没回答' ? late.promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.send('已经聊过');
  f.$('aiMemory').value = 'm_1'; f.$('aiAddPhoto').click(); f.$('aiReadPhoto').checked = true;
  await f.suggest(); f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  const pending = f.send('还没回答');
  await f.$('aiRealtimeEntry').click();
  assert.equal(f.actionCalls('aiChat').at(-1).signal.aborted, true);
  assert.equal(f.actionCalls('aiActionCancel').length, 1);
  assert.equal(f.$('aiQuestion'), null);
  await f.$('realtimeText').click(); await settle();
  late.resolve({ answer: '迟到回复', action: { kind: 'message' } }); await pending;
  assert.equal(f.$('aiQuestion').value, '还没回答');
  assert.match(f.$('aiMessages').textContent, /已经聊过/); assert.doesNotMatch(f.$('aiMessages').textContent, /迟到回复/);
  assert.equal(f.$('actionConfirm'), null); assert.equal(f.$('aiReadPhoto').checked, true);
  await f.send('接着聊');
  assert.deepEqual(f.actionCalls('aiChat').at(-1).data.messageIds, ['m_1']);
  assert.equal(f.actionCalls('aiChat').at(-1).data.history[0].content, '已经聊过');
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.actionCalls('aiActionConfirm').length, 0);
});

test('realtime close resumes same text window but account disposal clears its suspended private content', async () => {
  const f = fixture({ realTime: true });
  await f.context.MemoryAI.open(); await f.send('旧账号聊天');
  await f.$('aiRealtimeEntry').click(); await f.$('realtimeClose').click(); await settle();
  assert.match(f.$('aiMessages').textContent, /旧账号聊天/);
  await f.$('aiRealtimeEntry').click(); f.context.MemoryAI.dispose(true); f.context.session = { token: 'account-b' };
  await f.context.MemoryAI.resume();
  assert.equal(f.$('aiMessages').textContent, ''); assert.equal(f.$('aiQuestion').value, '');
});

test('failed and interrupted capability checks can retry without losing typed draft', async () => {
  let checks = 0;
  const f = fixture({ realTime: true, api: (call, normal) => { if (call.action === 'aiCapabilities' && ++checks === 1) throw Error('configuration details'); return normal(call.action, call.data); } });
  await f.context.MemoryAI.open(); f.$('aiQuestion').value = '先写下来';
  assert.equal(f.$('aiSend').disabled, true); assert.equal(f.$('aiRetry').hidden, false);
  assert.doesNotMatch(f.$('aiCapabilities').textContent, /configuration/);
  await f.$('aiRetry').click(); assert.equal(f.$('aiSend').disabled, false); assert.equal(f.$('aiQuestion').value, '先写下来');
  const pending = deferred(); let first = true;
  const g = fixture({ realTime: true, api: (call, normal) => { if (call.action === 'aiCapabilities' && first) { first = false; return pending.promise; } return normal(call.action, call.data); } });
  const opening = g.context.MemoryAI.open(); await g.$('aiRealtimeEntry').click();
  await g.$('realtimeText').click(); await settle(); pending.resolve({ text: false }); await opening;
  assert.equal(g.$('aiSend').disabled, false);
});

test('keyboard shortcut sends once and respects composition and unavailable functions', async () => {
  const f = fixture(); await f.context.MemoryAI.open();
  f.$('aiQuestion').value = '键盘输入';
  for (const event of [{ key: 'Enter' }, { key: 'Enter', ctrlKey: true, isComposing: true }]) f.$('aiQuestion').onkeydown(event);
  assert.equal(f.actionCalls('aiChat').length, 0);
  f.$('aiQuestion').onkeydown({ key: 'Enter', ctrlKey: true, isComposing: false, preventDefault() {} }); await settle();
  assert.equal(f.actionCalls('aiChat').length, 1);
});

test('background capability reply updates availability but never starts audio', async () => {
  const pending = deferred();
  const f = fixture({ realTime: true, api: call => call.action === 'aiRealtimeCapabilities' ? pending.promise : {} });
  const opening = f.context.MemoryRealtime.open(); f.document.hidden = true; f.listeners.visibilitychange();
  pending.resolve({ enabled: false }); await opening;
  assert.match(f.$('realtimeAvailability').textContent, /尚未开通/);
  f.document.hidden = false;
  assert.equal(f.$('realtimeStart').disabled, true); assert.equal(f.microphoneCalls(), 0);
});

test('message-only Demo offers an explicit reminder choice without loading calling capabilities or starting a call', async () => {
  const f = fixture(); delete f.context.MemoryCall;
  await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
  assert.equal(f.$('actionChooseCall'), null);
  assert.equal(f.actionCalls('callCapabilities').length, 0);
  assert.equal(f.actionCalls('aiActionPrepare').length, 0);
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
  f.$('actionChooseReminder').click();
  f.$('actionRecipient').value = 'member-b'; await f.$('actionPrepare').click();
  assert.equal(f.actionCalls('aiActionPrepare')[0].data.mode, 'request-only');
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
  assert.match(f.$('actionRecipientPreview').textContent, /mber-b/);
  assert.match(f.$('actionScope').textContent, /站内联系提醒/);
  await f.$('actionConfirm').click();
  assert.equal(f.actionCalls('aiActionConfirm').length, 1);
  assert.equal(f.callStarts.length, 0);
  assert.equal(f.microphoneCalls(), 0);
  const html = fs.readFileSync(path.join(__dirname, '../server/public/index.html'), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="\/family-call\./);
  assert.match(html, /unseen-sans\/fonts.css/);
});

// Recovery tests run the actual durable action state machine behind the DOM
// controller, including its validation, expiry, leases and idempotent effects.
async function durableActions(t, { photos = false } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'frame-action-ui-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const store = new LocalStore(dir); await store.init();
  if (photos) for (let i = 1; i <= 2; i++) {
    await store.put({ _id: `m_${i}`, kind: 'message', room: 'home', image: `photo${i}` });
    await store.put({ _id: `f_photo${i}`, kind: 'file', room: 'home', file: `photo${i}.jpg`, mime: 'image/jpeg', bytes: 100, digest: `digest${i}` });
  }
  let now = Date.now();
  const owner = { _id: 's_owner', account: 'u_owner', role: 'owner', room: 'home' };
  const members = [{ id: 'member-a', name: '小明', role: 'family' }, { id: 'member-b', name: '小明', role: 'family' }];
  const effects = new Map(), sends = [], hooks = {};
  const actions = createActions(store, {
    authenticate: async token => { assert.equal(token, 'account-a'); return owner; },
    roster: async () => copy(members), clock: () => now,
    send: async data => {
      sends.push(copy(data)); await hooks.beforeSend?.(data);
      const id = 'm_' + data.id; effects.set(id, copy(data)); return { id };
    }, contactRequest: async () => { throw Error('unexpected contact'); }
  });
  const f = fixture({ api: async (call, normal) => {
    if (call.action === 'contactState') return { members: copy(members) };
    if (!call.action.startsWith('aiAction')) return normal(call.action, call.data);
    if (call.action === 'aiActionGet') await hooks.beforeGet?.();
    const run = () => actions.handle(call.action, call.data, owner, call.token);
    const result = call.action === 'aiActionConfirm' && hooks.confirm ? await hooks.confirm(run) : await run();
    await hooks.after?.(call, result); return result;
  } });
  await f.context.MemoryAI.open(); await f.suggest({ usePhotos: photos });
  f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  const original = copy(f.actionCalls('aiActionPrepare')[0].data);
  const prepared = (await store.list('ai-actions'))[0].entries[0];
  const identity = { actionId: prepared.actionId, version: prepared.version };
  return { ...f, store, members, effects, sends, hooks, original, identity,
    get: () => actions.handle('aiActionGet', { actionId: identity.actionId }, owner, 'account-a'),
    advance: ms => { now += ms; } };
}

async function durableCallAction(t, { delayStart = false } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'frame-ai-call-ui-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const store = new LocalStore(dir); await store.init();
  const caller = { _id: 'member-a', kind: 'session', role: 'owner', room: 'home', name: '甲', expires: Date.now() + 86400000 };
  const callee = { ...caller, _id: 'member-b', role: 'family', name: '乙' };
  await store.put(caller); await store.put(callee);
  const authenticate = async token => {
    const s = await store.get(token === 'account-a' ? caller._id : 'missing');
    if (!s || s.revoked) throw Object.assign(Error('登录失效'), { status: 401 }); return s;
  };
  const calls = createFamilyCall(store, { allowed: async () => true, env: {
    MEMORY_CALL_ENABLED: '1', MEMORY_CALL_ICE_SERVERS_JSON: '[{"urls":"turn:relay.example.test:3478"}]',
    MEMORY_CALL_TURN_SECRET: 'test-only-local-controlled-relay-secret'
  } });
  const beforeStart = deferred(), startGate = deferred(), completed = deferred(), cancelled = deferred(), hooks = {};
  const actions = createActions(store, {
    authenticate, roster: async () => [{ id: callee._id, name: callee.name, role: callee.role }],
    send: async () => { throw Error('unexpected message'); }, contactRequest: async () => { throw Error('unexpected reminder'); },
    callCapabilities: s => calls.handle('callCapabilities', {}, s),
    callRequest: async (data, s) => { beforeStart.resolve(); if (delayStart) await startGate.promise; return calls.handle('callStart', data, s); }
  });
  const f = fixture({ realCalls: true, api: async (call, normal) => {
    if (call.action === 'contactState') return { members: [{ id: callee._id, name: callee.name, role: callee.role }] };
    if (call.action.startsWith('call')) {
      if (call.action === 'callCancelStart') await hooks.cancel?.();
      const result = await calls.handle(call.action, call.data, await authenticate(call.token));
      if (call.action === 'callCancelStart') cancelled.resolve(result);
      return result;
    }
    if (call.action === 'aiActionConfirm') {
      // The real server keeps processing after browser fetch abort. The client
      // never receives the completed result, even when it was durably saved.
      actions.handle(call.action, call.data, await authenticate(call.token), call.token)
        .then(value => completed.resolve({ value }), error => completed.resolve({ error }));
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(Error('fetch aborted'), { name: 'AbortError' }));
        if (call.signal.aborted) abort(); else call.signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (call.action.startsWith('aiAction')) return actions.handle(call.action, call.data, await authenticate(call.token), call.token);
    return normal(call.action, call.data);
  } });
  await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
  f.$('actionChooseCall').click(); f.$('actionRecipient').value = callee._id; await f.$('actionPrepare').click();
  const entry = (await store.list('ai-actions'))[0].entries[0];
  const preview = await actions.handle('aiActionGet', { actionId: entry.actionId }, caller, 'account-a');
  const pending = f.$('actionConfirm').click(); await beforeStart.promise;
  async function settledCancellation() {
    assert.equal((await cancelled.promise).cancelled, true);
    assert.ok((await store.get('rtc_home')).starts.some(item => item.cancelled));
    await settle();
  }
  return { ...f, store, preview, pending, completed: completed.promise, releaseStart: startGate.resolve, hooks, settledCancellation,
    callState: () => calls.handle('callState', {}, caller),
    accept: id => calls.handle('callAccept', { id }, callee) };
}

test('ordinary multi-turn chat keeps prior answers and bounds history to the advertised six rounds', async () => {
  const f = fixture(); await f.context.MemoryAI.open();
  await f.send('今天过得怎么样'); await f.send('接着聊');
  assert.deepEqual(f.actionCalls('aiChat')[1].data.history, [
    { role: 'user', content: '今天过得怎么样' }, { role: 'assistant', content: '答：今天过得怎么样' }
  ]);
  assert.equal(f.$('aiMessages').children.length, 4);
  for (let i = 0; i < 6; i++) await f.send(`第${i}次追问`);
  assert.equal(f.actionCalls('aiChat').at(-1).data.history.length, 12);
  assert.equal(f.$('aiMessages').children.length, 12);
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
});

test('adding and removing photos changes only the explicit image context and preserves conversation', async () => {
  const f = fixture(); await f.context.MemoryAI.open(); await f.send('先聊聊今天');
  const original = f.$('aiMessages').textContent;
  for (const id of ['m_1', 'm_2']) { f.$('aiMemory').value = id; f.$('aiAddPhoto').click(); }
  assert.equal(f.$('aiMessages').textContent, original);
  f.$('aiReadPhoto').checked = true; f.$('aiReadPhoto').onchange();
  await f.send('比较这两张照片');
  assert.deepEqual(f.actionCalls('aiChat').at(-1).data.messageIds, ['m_1', 'm_2']);
  assert.equal(f.actionCalls('aiChat').at(-1).data.readPhoto, true);
  assert.equal(f.actionCalls('aiChat').at(-1).data.history[0].content, '先聊聊今天');
  f.$('aiPhotos').querySelectorAll('button')[0].click();
  assert.equal(f.$('aiMessages').children.length, 4);
  await f.send('留下的是哪张');
  assert.deepEqual(f.actionCalls('aiChat').at(-1).data.messageIds, ['m_2']);
  f.$('aiPhotos').querySelectorAll('button')[0].click();
  assert.equal(f.$('aiReadPhoto').checked, false);
  await f.send('继续日常聊天');
  assert.deepEqual(f.actionCalls('aiChat').at(-1).data.messageIds, []);
  assert.equal(f.actionCalls('aiChat').at(-1).data.history.length, 6);
});

test('closing during microphone permission cancels recording and ignores a late successful start', async () => {
  const microphone = deferred(), f = fixture({ startVoice: () => microphone.promise });
  await f.context.MemoryAI.open();
  const recording = f.$('aiRecord').click(), dialog = f.document.querySelector('dialog');
  const before = f.speechCancels(); f.$('aiClose').click();
  assert.equal(f.recorders[0].cancels, 1);
  assert.equal(f.speechCancels(), before + 1);
  assert.equal(dialog.open, false); assert.equal(dialog.isConnected, false);
  microphone.resolve(true); await recording;
  assert.equal(f.document.querySelector('dialog'), null);
  assert.equal(f.actionCalls('aiTranscribe').length, 0);
});

test('closing stops speech synthesis and stale speech callbacks cannot alter a reopened conversation', async () => {
  const f = fixture(); await f.context.MemoryAI.open(); await f.send('讲一句话');
  f.$('aiSpeak').click(); const utterance = f.utterances[0], before = f.speechCancels();
  assert.equal(utterance.text, '答：讲一句话');
  f.$('aiClose').click(); assert.equal(f.speechCancels(), before + 1);
  await f.context.MemoryAI.open(); const status = f.$('aiStatus').textContent;
  utterance.onend(); utterance.onerror();
  assert.equal(f.$('aiStatus').textContent, status);
});

test('backgrounding aborts chat and releases recording and speech without erasing successful history', async () => {
  const late = deferred();
  const f = fixture({ api: (call, normal) => call.action === 'aiChat' && call.data.text === '等待' ? late.promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.send('已完成');
  const pending = f.send('等待'), request = f.actionCalls('aiChat').at(-1), before = f.speechCancels();
  f.document.hidden = true; f.listeners.visibilitychange();
  assert.equal(request.signal.aborted, true); assert.equal(f.speechCancels(), before + 1);
  late.resolve({ answer: '不应出现', action: null }); await pending;
  assert.equal(f.$('aiMessages').children.length, 2); assert.doesNotMatch(f.$('aiMessages').textContent, /不应出现/);
  f.document.hidden = false; await f.$('aiRecord').click();
  f.document.hidden = true; f.listeners.visibilitychange();
  assert.equal(f.recorders[0].cancels, 1); assert.equal(f.$('aiRecord').textContent, '用语音输入');
});

test('a late chat reply from a previous account cannot write history or actions into the new account', async () => {
  const oldReply = deferred();
  const f = fixture({ api: (call, normal) => call.action === 'aiChat' && call.token === 'account-a' ? oldReply.promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); const oldSend = f.send('旧账号的秘密');
  const oldRequest = f.actionCalls('aiChat')[0];
  f.context.MemoryAI.dispose(); f.context.session = { token: 'account-b' };
  await f.context.MemoryAI.open(); await f.send('新账号聊天');
  oldReply.resolve({ answer: '旧账号回答', action: { kind: 'message', targetHint: '小明', text: '不要发送', usePhotos: false, useVoice: false } });
  await oldSend;
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(f.$('aiMessages').children.length, 2);
  assert.doesNotMatch(f.$('aiMessages').textContent, /旧账号/);
  assert.equal(f.actionCalls('contactState').length, 0);
  await f.send('继续');
  assert.equal(f.actionCalls('aiChat').at(-1).data.history[0].content, '新账号聊天');
});

test('a late capability reply from a closed window cannot disable the newer window', async () => {
  const oldCaps = deferred(); let check = 0;
  const f = fixture({ api: (call, normal) => call.action === 'aiCapabilities' && ++check === 1 ? oldCaps.promise : normal(call.action, call.data) });
  const firstOpen = f.context.MemoryAI.open();
  await f.context.MemoryAI.open(); assert.equal(f.$('aiSend').disabled, false);
  oldCaps.resolve({ text: true, vision: true, asr: true }); await firstOpen;
  f.$('aiMemory').value = 'm_1'; f.$('aiAddPhoto').click();
  assert.equal(f.$('aiSend').disabled, false);
  assert.equal(f.$('aiRecord').disabled, false);
});

test('closing an original-voice preview pauses its audio and revokes its object URL', async () => {
  const f = fixture(); await f.context.MemoryAI.open();
  await f.$('aiRecord').click(); await f.$('aiRecord').click();
  const audio = f.$('aiVoicePreview').querySelector('audio'); assert.ok(audio);
  f.$('aiClose').click();
  assert.ok(audio.pauses >= 1);
  assert.equal(audio.paused, true);
  assert.deepEqual(f.revoked, [audio.src]);
});

test('action suggestions require choosing an actual recipient and a separate explicit confirmation', async () => {
  const f = fixture(); await f.context.MemoryAI.open(); await f.suggest();
  assert.equal(f.$('actionRecipient').value, '', 'a name shared by two members must not be resolved implicitly');
  assert.match(f.$('actionScope').textContent, /家庭成员均可见/);
  await f.$('actionPrepare').click(); assert.equal(f.actionCalls('aiActionPrepare').length, 0);
  f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
  assert.match(f.$('actionRecipientPreview').textContent, /小明 · 家人 · mber-a/);
  await f.send('好');
  assert.equal(f.actionCalls('aiActionConfirm').length, 0, 'a conversational yes cannot click a confirmation card');
  await f.$('actionConfirm').click();
  assert.deepEqual(f.actionCalls('aiActionConfirm')[0].data, { actionId: 'candidate-1', version: 1 });
  assert.equal(f.polls(), 1);
});

test('modifying cancels the old durable card before editing and explicitly confirms only the replacement', async t => {
  const f = await durableActions(t), revision = deferred(); f.hooks.beforeGet = () => revision.promise;
  const oldConfirm = f.$('actionConfirm'), modifying = f.$('actionModify').click();
  assert.equal(oldConfirm.disabled, true); oldConfirm.click(); assert.equal(f.actionCalls('aiActionConfirm').length, 0);
  revision.resolve(); await modifying;
  assert.equal((await f.get()).status, 'cancelled');
  assert.equal(oldConfirm.isConnected, false); assert.equal(f.$('actionConfirm'), null);
  f.$('actionText').value = '修改后的明确留言'; await f.$('actionPrepare').click();
  assert.equal(f.actionCalls('aiActionPrepare').at(-1).data.actionId, undefined);
  assert.match(f.$('actionTextPreview').textContent, /修改后的明确留言/);
  await f.$('actionConfirm').click();
  assert.notEqual(f.actionCalls('aiActionConfirm').at(-1).data.actionId, f.identity.actionId);
  assert.equal(f.effects.size, 1); assert.equal(f.sends.length, 1);
});

test('cancelling a ready action invalidates its exact candidate and removes every executable control', async () => {
  const f = fixture(); await f.context.MemoryAI.open(); await f.suggest();
  f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  const oldConfirm = f.$('actionConfirm'); f.$('actionCancel').click();
  assert.deepEqual(f.actionCalls('aiActionCancel')[0].data, { actionId: 'candidate-1', version: 1 });
  assert.equal(oldConfirm.isConnected, false); assert.equal(f.$('actionConfirm'), null);
  oldConfirm.click(); assert.equal(f.actionCalls('aiActionConfirm').length, 0);
});

test('a late family roster cannot replace another account action form', async () => {
  const oldRoster = deferred();
  const f = fixture({ api: (call, normal) => call.action === 'contactState' && call.token === 'account-a' ? oldRoster.promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); const oldSuggestion = f.suggest({ text: '旧留言' });
  f.context.MemoryAI.dispose(); f.context.session = { token: 'account-b' };
  await f.context.MemoryAI.open(); await f.suggest({ text: '新留言' });
  oldRoster.resolve({ members: [{ id: 'old-family', name: '旧家庭', role: 'family' }] }); await oldSuggestion;
  assert.equal(f.$('actionText').value, '新留言');
  assert.doesNotMatch(f.$('actionRecipient').textContent, /旧家庭/);
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
});

test('contact requests require accepting the reminder-only mode before preparing an action', async () => {
  const f = fixture(); await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
  assert.equal(f.$('actionPrepare'), null); assert.equal(f.$('actionConfirm'), null);
  f.$('actionChooseReminder').click(); f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  assert.equal(f.actionCalls('aiActionPrepare')[0].data.mode, 'request-only');
  assert.match(f.$('actionScope').textContent, /不传输通话音频/);
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
});

test('closing during voice conversion discards late audio without allocating a preview URL', async () => {
  const converting = deferred(), f = fixture({ finishVoice: () => converting.promise });
  await f.context.MemoryAI.open(); await f.$('aiRecord').click();
  const finishing = f.$('aiRecord').click(); f.$('aiClose').click();
  await f.context.MemoryAI.open();
  converting.resolve(new Blob(['stale audio'], { type: 'audio/wav' })); await finishing;
  assert.equal(f.urls.length, 0);
  assert.equal(f.actionCalls('aiTranscribe').length, 0);
  assert.equal(f.$('aiVoicePreview').children.length, 0);
  assert.equal(f.$('aiRecord').disabled, false);
});

test('late transcription from a closed conversation cannot overwrite the new account input', async () => {
  const transcription = deferred();
  const f = fixture({ api: (call, normal) => call.action === 'aiTranscribe' ? transcription.promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.$('aiRecord').click();
  const finishing = f.$('aiRecord').click(); await settle();
  const audio = f.$('aiVoicePreview').querySelector('audio');
  assert.equal(f.actionCalls('aiTranscribe').length, 1);
  f.context.MemoryAI.dispose(); f.context.session = { token: 'account-b' };
  await f.context.MemoryAI.open(); f.$('aiQuestion').value = '新账号正在输入';
  transcription.resolve({ text: '旧账号的转写' }); await finishing;
  assert.equal(f.actionCalls('aiTranscribe')[0].signal.aborted, true);
  assert.equal(f.$('aiQuestion').value, '新账号正在输入');
  assert.equal(f.$('aiVoicePreview').children.length, 0);
  assert.equal(audio.paused, true); assert.ok(f.revoked.includes(audio.src));
});

test('clearing a conversation prevents a pending preparation from restoring an executable action card', async () => {
  const prepared = deferred();
  const f = fixture({ api: (call, normal) => call.action === 'aiActionPrepare' ? prepared.promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.suggest(); f.$('actionRecipient').value = 'member-a';
  const preparing = f.$('actionPrepare').click(); f.$('aiNew').click();
  assert.equal(f.actionCalls('aiActionPrepare')[0].signal.aborted, true);
  prepared.resolve(f.defaultResponse('aiActionPrepare', f.actionCalls('aiActionPrepare')[0].data)); await preparing;
  assert.equal(f.$('actionConfirm'), null);
  assert.equal(f.$('aiAction').children.length, 0);
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
});

test('a stale confirmation reply cannot unlock or cancel a newer in-flight confirmation', async () => {
  const confirms = [deferred(), deferred()]; let confirming = 0;
  const f = fixture({ api: (call, normal) => call.action === 'aiActionConfirm' ? confirms[confirming++].promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.suggest(); f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  const firstConfirm = f.$('actionConfirm').click();
  await f.suggest({ text: '第二条明确留言' }); f.$('actionRecipient').value = 'member-b'; await f.$('actionPrepare').click();
  const secondConfirm = f.$('actionConfirm').click();
  confirms[0].resolve({ status: 'completed', kind: 'message' }); await firstConfirm;
  assert.equal(f.$('actionConfirm').disabled, true);
  assert.match(f.$('actionStatus').textContent, /正在执行/);
  f.$('aiClose').click();
  assert.equal(f.actionCalls('aiActionCancel').length, 0, 'closing an in-flight action cannot pretend that execution was cancelled');
  confirms[1].resolve({ status: 'completed', kind: 'message' }); await secondConfirm;
  assert.equal(f.polls(), 0, 'neither stale completion may refresh a replacement view');
});

test('a timed-out chat aborts its fetch, clears its timer, and lets the user retry without losing history', async () => {
  const f = fixture({ api: (call, normal) => call.action === 'aiChat' && call.data.text === '等待超时'
    ? new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.send('已保存的聊天');
  assert.equal(f.timers.size, 0);
  const pending = f.send('等待超时');
  assert.equal(f.timers.size, 1); const timeout = [...f.timers.values()][0]; assert.equal(timeout.ms, 65000);
  timeout.fn(); await pending;
  assert.equal(f.actionCalls('aiChat').at(-1).signal.aborted, true);
  assert.equal(f.timers.size, 0); assert.equal(f.$('aiSend').disabled, false);
  assert.match(f.$('aiStatus').textContent, /超时/); assert.equal(f.$('aiMessages').children.length, 2);
  await f.send('改问一句'); assert.equal(f.actionCalls('aiChat').at(-1).data.history[0].content, '已保存的聊天');
});

test('confirmation timeout states uncertainty and retries only the same candidate id and version', async () => {
  let attempt = 0;
  const f = fixture({ api: (call, normal) => call.action === 'aiActionConfirm' && ++attempt === 1
    ? new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.suggest(); f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  const pending = f.$('actionConfirm').click();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0].fn(); await pending;
  assert.equal(f.timers.size, 0); assert.match(f.$('actionStatus').textContent, /尚未确定/);
  assert.equal(f.$('actionConfirm').disabled, false); assert.equal(f.polls(), 0);
  await f.$('actionConfirm').click();
  assert.deepEqual(f.actionCalls('aiActionConfirm').map(call => call.data), [
    { actionId: 'candidate-1', version: 1 }, { actionId: 'candidate-1', version: 1 }
  ]);
  assert.equal(f.polls(), 1); assert.equal(f.timers.size, 0);
});

test('a suggested original-voice action can be changed to text when no recording exists', async () => {
  const f = fixture(); await f.context.MemoryAI.open(); await f.suggest({ useVoice: true, text: '' });
  assert.equal(f.$('actionVoice').checked, false); assert.equal(f.$('actionVoice').disabled, true);
  f.$('actionRecipient').value = 'member-a'; f.$('actionText').value = '改为文字：明天见';
  await f.$('actionPrepare').click();
  assert.equal(f.actionCalls('aiActionPrepare').length, 1);
  assert.equal(f.actionCalls('aiActionPrepare')[0].data.audioId, '');
  assert.match(f.$('actionTextPreview').textContent, /改为文字/);
  assert.equal(f.actionCalls('aiActionConfirm').length, 0);
});

test('canonical same-name recipients remain distinguishable on the final confirmation card', async () => {
  const f = fixture(); await f.context.MemoryAI.open(); await f.suggest();
  f.$('actionRecipient').value = 'member-b'; await f.$('actionPrepare').click();
  assert.equal(f.$('actionRecipientPreview').textContent, '收件人：小明 · 家人 · mber-b');
  assert.equal(f.$('actionRecipientPreview').title, 'member-b');
  assert.equal(f.actionCalls('aiActionPrepare')[0].data.targetId, 'member-b');
});

test('a removed real recipient can be replaced after the invalid old candidate is cancelled', async t => {
  const f = await durableActions(t); f.members.splice(0, 1);
  await f.$('actionConfirm').click();
  assert.equal(f.$('actionConfirm').disabled, true);
  assert.equal(f.$('actionModify').disabled, false); assert.equal(f.$('actionCancel').disabled, false);
  assert.match(f.$('actionStatus').textContent, /修改或取消/);
  await f.$('actionModify').click(); assert.ok(f.$('actionRecipient'));
  assert.equal(f.$('actionRecipient').value, ''); assert.equal((await f.get()).status, 'cancelled');
  f.$('actionRecipient').value = 'member-b'; await f.$('actionPrepare').click();
  await f.$('actionConfirm').click(); assert.equal(f.effects.size, 1);
  assert.notEqual(f.actionCalls('aiActionConfirm').at(-1).data.actionId, f.identity.actionId);
});

test('an expired unstarted durable action opens a fresh confirmation after cancelling the old card', async t => {
  const f = await durableActions(t); f.advance(TTL + 1);
  await f.$('actionConfirm').click(); assert.match(f.$('actionStatus').textContent, /过期/);
  await f.$('actionModify').click(); assert.ok(f.$('actionRecipient')); assert.equal((await f.get()).status, 'cancelled');
  await f.$('actionPrepare').click(); await f.$('actionConfirm').click();
  assert.equal(f.effects.size, 1); assert.notEqual(f.actionCalls('aiActionConfirm').at(-1).data.actionId, f.identity.actionId);
});

test('modifying after a lost completed response queries the durable result without another execution', async t => {
  const f = await durableActions(t);
  f.hooks.after = call => { if (call.action === 'aiActionConfirm') throw Error('网络响应丢失'); };
  await f.$('actionConfirm').click(); assert.equal(f.effects.size, 1);
  await f.$('actionModify').click();
  assert.match(f.$('actionStatus').textContent, /已完成/); assert.equal(f.$('actionRecipient'), null);
  assert.equal(f.$('actionConfirm').disabled, true); assert.equal(f.$('actionCancel').disabled, false);
  assert.equal(f.actionCalls('aiActionPrepare').length, 1); assert.equal(f.actionCalls('aiActionCancel').length, 0);
  assert.equal(f.sends.length, 1); assert.equal(f.effects.size, 1);
});

test('a failed durable execution stays on its original id and version when modifying or retrying', async t => {
  const f = await durableActions(t); f.hooks.beforeSend = () => { throw Error('临时发送故障'); };
  await f.$('actionConfirm').click(); assert.equal((await f.get()).status, 'failed');
  await f.$('actionModify').click();
  assert.equal(f.$('actionRecipient'), null); assert.equal(f.$('actionConfirm').disabled, false);
  assert.match(f.$('actionStatus').textContent, /内容不能修改/);
  delete f.hooks.beforeSend; await f.$('actionConfirm').click();
  assert.deepEqual(f.actionCalls('aiActionConfirm').map(call => call.data), [f.identity, f.identity]);
  assert.equal(f.effects.size, 1); assert.equal(f.actionCalls('aiActionPrepare').length, 1);
});

test('a processing durable action remains queryable after its transport response is lost', async t => {
  const f = await durableActions(t), entered = deferred(), release = deferred(); let pending;
  f.hooks.beforeSend = async () => { entered.resolve(); await release.promise; };
  f.hooks.confirm = async run => { pending = run(); await entered.promise; throw Error('网络连接中断'); };
  await f.$('actionConfirm').click(); assert.equal((await f.get()).status, 'processing');
  await f.$('actionModify').click(); assert.equal(f.$('actionRecipient'), null);
  assert.equal(f.$('actionConfirm').disabled, false); assert.equal(f.$('actionModify').disabled, false);
  release.resolve(); await pending;
  await f.$('actionModify').click(); assert.match(f.$('actionStatus').textContent, /已完成/);
  assert.equal(f.sends.length, 1); assert.equal(f.effects.size, 1); assert.equal(f.actionCalls('aiActionPrepare').length, 1);
});

test('a failed state query restores the original retry and query controls without a new candidate', async t => {
  const f = await durableActions(t);
  f.hooks.after = call => { if (call.action === 'aiActionConfirm') throw Error('网络响应丢失'); };
  await f.$('actionConfirm').click();
  f.hooks.beforeGet = () => { throw Error('查询暂时失败'); };
  await f.$('actionModify').click(); assert.equal(f.$('actionConfirm').disabled, false);
  assert.equal(f.$('actionModify').disabled, false); assert.equal(f.$('actionCancel').disabled, false);
  assert.equal(f.$('actionRecipient'), null); assert.match(f.$('actionStatus').textContent, /保留原行动/);
  delete f.hooks.beforeGet; await f.$('actionModify').click(); assert.match(f.$('actionStatus').textContent, /已完成/);
  assert.equal(f.sends.length, 1); assert.equal(f.actionCalls('aiActionPrepare').length, 1);
});

test('an expired action that had started cannot be copied into a new candidate', async t => {
  const f = await durableActions(t); f.hooks.beforeSend = () => { throw Error('临时故障'); };
  await f.$('actionConfirm').click(); f.advance(TTL + 1);
  assert.equal((await f.get()).started, true); assert.equal((await f.get()).status, 'expired');
  await f.$('actionModify').click(); assert.equal(f.$('actionRecipient'), null);
  assert.equal(f.$('actionConfirm').disabled, true); assert.match(f.$('actionStatus').textContent, /曾开始执行/);
  assert.equal(f.actionCalls('aiActionPrepare').length, 1); assert.equal(f.effects.size, 0);
});

for (const partial of [true, false]) test(`cancellation rechecks a late durable execution after the ready snapshot (${partial ? 'first photo sent' : 'no effect yet'})`, async t => {
  const f = await durableActions(t, { photos: true }); let delayedConfirm;
  f.hooks.confirm = async run => { delayedConfirm = run; throw Error('客户端等待超时，后台请求仍待处理'); };
  f.hooks.beforeSend = data => { if (!partial || data.image === 'photo2') throw Error('稍后发送失败'); };
  await f.$('actionConfirm').click(); assert.equal((await f.get()).started, false);
  f.hooks.after = async (call, snapshot) => {
    if (call.action !== 'aiActionGet') return;
    delete f.hooks.after;
    assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.started, false);
    // The original timed-out request runs after Get read its snapshot but before
    // Modify cancels. Both sends and the cancellation use the real CAS backend.
    await assert.rejects(delayedConfirm(), /稍后发送失败/);
    const latest = await f.get(); assert.equal(latest.status, 'failed'); assert.equal(latest.started, true);
    assert.equal(latest.completed, partial ? 1 : 0);
  };
  await f.$('actionModify').click();
  const stopped = await f.get(); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.started, true);
  assert.equal(stopped.completed, partial ? 1 : 0); assert.equal(stopped.actionId, f.identity.actionId);
  assert.equal(f.$('actionRecipient'), null); assert.equal(f.$('actionPrepare'), null);
  assert.equal(f.$('actionConfirm').disabled, true); assert.equal(f.$('actionModify').disabled, false);
  assert.match(f.$('actionStatus').textContent, /取消前已开始执行/);
  await f.$('actionModify').click(); assert.equal(f.$('actionRecipient'), null);
  assert.equal(f.actionCalls('aiActionPrepare').length, 1);
  assert.deepEqual(f.actionCalls('aiActionCancel')[0].data, f.identity);
  assert.equal(f.effects.size, partial ? 1 : 0);
  assert.deepEqual([...f.effects.values()].map(item => item.image), partial ? ['photo1'] : []);
});

test('audio calling requires explicit mode, recipient, and confirmation before joining the created call', async () => {
  const f = fixture({ api: (call, normal) => call.action === 'callCapabilities' ? { audioCall: true }
    : call.action === 'aiActionConfirm' ? { kind: 'contact', status: 'completed', targetId: 'member-b', results: [{ kind: 'contact', mode: 'audio-call', callId: 'call-fixture' }] } : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
  assert.equal(f.$('actionChooseCall').disabled, false); assert.equal(f.callStarts.length, 0);
  f.$('actionChooseCall').click(); f.$('actionRecipient').value = 'member-b'; await f.$('actionPrepare').click();
  assert.equal(f.actionCalls('aiActionPrepare')[0].data.mode, 'audio-call');
  assert.match(f.$('actionScope').textContent, /浏览器语音呼叫/); assert.match(f.$('actionRecipientPreview').textContent, /mber-b/);
  assert.equal(f.callStarts.length, 0); assert.equal(f.actionCalls('callStart').length, 0);
  await f.$('actionConfirm').click();
  assert.deepEqual(f.callStarts, [{ targetId: 'member-b', callId: 'call-fixture' }]);
  assert.match(f.$('actionStatus').textContent, /尚未确认音频连接/);
  assert.equal(f.actionCalls('contactRequest').length, 0);
});

test('disabled or unsupported calling never silently selects or sends a contact reminder', async () => {
  for (const supported of [true, false]) {
    const f = fixture({ callSupported: supported, api: (call, normal) => call.action === 'callCapabilities' ? { audioCall: !supported, reason: '尚未配置受控中继' } : normal(call.action, call.data) });
    await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
    assert.equal(f.$('actionChooseCall').disabled, true); f.$('actionChooseCall').click();
    assert.equal(f.$('actionPrepare'), null); assert.equal(f.actionCalls('aiActionPrepare').length, 0); assert.equal(f.callStarts.length, 0);
    f.$('actionChooseReminder').click(); assert.ok(f.$('actionPrepare'));
    f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
    assert.equal(f.actionCalls('aiActionPrepare')[0].data.mode, 'request-only'); assert.equal(f.actionCalls('aiActionConfirm').length, 0);
  }
});

test('an existing family voice draft prevents confirming a call without destroying the draft', async () => {
  const f = fixture({ api: (call, normal) => call.action === 'callCapabilities' ? { audioCall: true } : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
  f.$('actionChooseCall').click(); f.$('actionRecipient').value = 'member-a'; await f.$('actionPrepare').click();
  const draft = { recording: 'family memory' }; f.context.recording = draft;
  await f.$('actionConfirm').click(); assert.equal(f.actionCalls('aiActionConfirm').length, 0);
  assert.equal(f.context.recording, draft); assert.match(f.$('actionStatus').textContent, /先结束/);
});

test('AI cannot confirm another call while termination is pending or its cleanup queue is full', async () => {
  const f = fixture({ canStart: false, api: (call, normal) => call.action === 'callCapabilities' ? { audioCall: true } : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
  f.$('actionChooseCall').click(); f.$('actionRecipient').value = 'member-b'; await f.$('actionPrepare').click();
  await f.$('actionConfirm').click();
  assert.equal(f.actionCalls('aiActionConfirm').length, 0); assert.equal(f.callStarts.length, 0);
  assert.match(f.$('actionStatus').textContent, /结束仍待服务器确认/);
});

for (const hiding of [false, true]) test(`AI ${hiding ? 'backgrounding' : 'closing'} cancels a durably accepted call when aborted fetch can never return its result`, async t => {
  const f = await durableCallAction(t), result = await f.completed;
  assert.equal(result.value.status, 'completed'); const id = result.value.results[0].callId;
  await f.accept(id); assert.equal((await f.callState()).calls[0].status, 'accepted');
  if (hiding) { f.document.hidden = true; f.listeners.visibilitychange(); }
  else f.context.MemoryAI.dispose();
  await f.pending; await f.settledCancellation();
  assert.equal(f.actionCalls('aiActionConfirm')[0].signal.aborted, true);
  assert.deepEqual(f.actionCalls('callCancelStart')[0].data, { requestId: f.preview.callRequestId });
  assert.equal((await f.callState()).calls[0].status, 'ended');
  f.document.hidden = false; f.listeners.visibilitychange(); await f.context.MemoryCall.refresh(true); await settle();
  assert.equal(f.microphoneCalls(), 0); assert.equal(f.actionCalls('callIce').length, 0);
  assert.equal(f.$('familyCallDialog').open, false); assert.equal(f.$('actionConfirm'), null);
});

test('AI closure cancels by preview request id before a delayed server call creation can commit', async t => {
  const f = await durableCallAction(t, { delayStart: true });
  f.context.MemoryAI.dispose(); await f.pending; await f.settledCancellation();
  f.releaseStart(); const result = await f.completed;
  assert.equal(result.error.status, 409); assert.equal((await f.callState()).calls.length, 0);
  assert.deepEqual(f.actionCalls('callCancelStart')[0].data, { requestId: f.preview.callRequestId });
  assert.equal(f.microphoneCalls(), 0);
});

test('an offline AI-call cancellation keeps its original authenticated id for a later bounded retry', async t => {
  const f = await durableCallAction(t); await f.completed;
  f.hooks.cancel = () => { throw Error('network offline'); };
  f.context.MemoryAI.dispose(); await f.pending; await settle();
  assert.equal((await f.callState()).calls[0].status, 'ringing');
  assert.equal(f.context.MemoryCall.hasPendingCancellations('account-a'), true);
  await f.context.MemoryCall.refresh(true); assert.equal(f.microphoneCalls(), 0);
  assert.equal(f.context.MemoryCall.hasPendingCancellations('account-a'), true);
  delete f.hooks.cancel; await f.context.MemoryCall.refresh(true); await f.settledCancellation();
  assert.equal((await f.callState()).calls[0].status, 'ended');
  assert.equal(f.context.MemoryCall.hasPendingCancellations('account-a'), false);
  assert.ok(f.actionCalls('callCancelStart').length >= 2);
  assert.deepEqual([...new Set(f.actionCalls('callCancelStart').map(item => item.data.requestId))], [f.preview.callRequestId]);
  assert.ok(f.actionCalls('callCancelStart').every(item => item.token === 'account-a'));
  assert.equal(f.microphoneCalls(), 0);
});

test('a hidden late AI result never hands a call to the media controller even before visibility events arrive', async () => {
  const delayed = deferred();
  const f = fixture({ api: (call, normal) => call.action === 'callCapabilities' ? { audioCall: true }
    : call.action === 'aiActionConfirm' ? delayed.promise : normal(call.action, call.data) });
  await f.context.MemoryAI.open(); await f.suggest({ kind: 'contact', text: '' });
  f.$('actionChooseCall').click(); f.$('actionRecipient').value = 'member-b'; await f.$('actionPrepare').click();
  const pending = f.$('actionConfirm').click(); f.document.hidden = true;
  delayed.resolve({ kind: 'contact', status: 'completed', targetId: 'member-b', results: [{ kind: 'contact', mode: 'audio-call', callId: 'late-hidden' }] });
  await pending; assert.equal(f.callStarts.length, 0); assert.deepEqual(f.callCancellations, [{ requestId: 'call-request-1', token: 'account-a' }]);
  f.document.hidden = false; f.listeners.visibilitychange(); assert.equal(f.callStarts.length, 0); assert.equal(f.$('actionConfirm'), null);
});

// Proactive entry is called only by an accepted frame invitation. These are
// controller/DOM and provider doubles, not browser or actual model evidence.
function presenceFixture(options = {}) {
  const f = fixture(options); f.context.frame = true;
  f.context.session.role = 'frame'; f.context.session.room = 'local-presence-fixture';
  return f;
}
test('confirmed presence asks once about its fixed photo and next manual turn keeps valid history pairs', async () => {
  const caps = deferred();
  const f = presenceFixture({ api: (call, normal) => call.action === 'aiCapabilities' ? caps.promise
    : call.action === 'aiChat' && !call.data.history.length ? { answer: '这张照片让您想起了什么？', imageUsed: true, action: { kind: 'contact', targetHint: '某人' } } : normal(call.action, call.data) });
  const pending = f.context.MemoryAI.openFromPresence('m_2');
  assert.equal(f.$('aiQuestion').disabled, true); assert.equal(f.$('aiReadPhoto').checked, false);
  assert.equal(f.$('aiPhotoPicker').open, false);
  await f.context.MemoryAI.openFromPresence('m_2');
  assert.equal(f.actionCalls('aiCapabilities').length, 1); assert.equal(f.actionCalls('aiChat').length, 0);
  f.context.state.messages.push({ _id: 'newest', type: 'photo', image: 'newest', imageURL: '/newest' });
  caps.resolve({ text: true, vision: true, asr: true }); const result = await pending;
  assert.equal(result.outcome, 'question'); assert.equal(f.actionCalls('aiChat').length, 1);
  assert.deepEqual(f.actionCalls('aiChat')[0].data.messageIds, ['m_2']);
  assert.equal(f.actionCalls('aiChat')[0].data.readPhoto, true);
  assert.match(f.$('aiMessages').textContent, /这张照片让您想起了什么？/);
  assert.equal(f.$('aiReadPhoto').checked, true); assert.equal(f.recorders.length, 0); assert.equal(f.microphoneCalls(), 0);
  assert.equal(f.$('aiAction').textContent, ''); assert.equal(f.utterances.length, 0);
  await f.send('这是多年前的一次旅行');
  const next = f.actionCalls('aiChat')[1].data;
  assert.deepEqual(next.history.map(item => item.role), ['user', 'assistant']);
  assert.equal(next.history[1].content, '这张照片让您想起了什么？');
});
test('ordinary open still selects a photo without reading it or starting AI', async () => {
  const f = presenceFixture(); await f.context.MemoryAI.open('m_2');
  assert.equal(f.$('aiPhotoPicker').open, true);
  assert.equal(f.actionCalls('aiChat').length, 0); assert.equal(f.$('aiReadPhoto').checked, false);
  assert.equal(f.recorders.length, 0);
});
test('presence hides only its automatic seed while identical manual speech remains visible and API history stays complete', async () => {
  const seed = '请根据这张照片，先问我一个问题。';
  const f = presenceFixture({ api: (call, normal) => call.action === 'aiChat' && !call.data.history.length
    ? { answer: '这张照片让您想起了什么？', imageUsed: true } : normal(call.action, call.data) });
  await f.context.MemoryAI.openFromPresence('m_2');
  assert.equal(f.$('aiMessages').textContent, 'AI：这张照片让您想起了什么？');
  await f.send(seed);
  const visible = f.$('aiMessages').querySelectorAll('p').map(item => item.textContent);
  assert.equal(visible.filter(text => text.startsWith('你：')).length, 1);
  assert.equal(visible[1], '你：' + seed);
  assert.deepEqual(f.actionCalls('aiChat')[1].data.history, [
    { role: 'user', content: seed }, { role: 'assistant', content: '这张照片让您想起了什么？' }
  ]);
  await f.send('继续聊聊');
  const history = f.actionCalls('aiChat')[2].data.history;
  assert.deepEqual(history.map(item => item.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(history[2].content, seed);
  assert.ok(history.every(item => Object.keys(item).sort().join(',') === 'content,role'));
});
const cancelPresence = {
  close: f => f.$('aiClose').click(),
  stop: f => f.$('aiStop').click(),
  clear: f => f.$('aiNew').click(),
  background: f => { f.document.hidden = true; f.listeners.visibilitychange(); },
  'hidden before visibility notification': f => { f.document.hidden = true; },
  'identity changed': f => { f.context.session = { token: 'account-b', role: 'frame', room: 'other-room' }; },
  'session expired': f => { f.context.sessionExpired = true; },
  'photo removed': f => { f.context.state.messages = f.context.state.messages.filter(item => item._id !== 'm_2'); f.context.MemoryAI.refreshProactive(); },
  'photo replaced': f => { f.context.state.messages.find(item => item._id === 'm_2').image = 'replacement'; f.context.MemoryAI.refreshProactive(); },
  'family recording started': f => { f.context.recording = {}; f.context.MemoryAI.refreshProactive(); },
  'switch to realtime': f => f.context.MemoryAI.suspendForRealtime()
};
for (const [name, cancel] of Object.entries(cancelPresence)) test('presence capability response cannot start AI after ' + name, async () => {
  const caps = deferred(); const f = presenceFixture({ api: (call, normal) => call.action === 'aiCapabilities' ? caps.promise : normal(call.action, call.data) });
  const pending = f.context.MemoryAI.openFromPresence('m_2'); cancel(f);
  caps.resolve({ text: true, vision: true, asr: true }); await pending;
  assert.equal(f.actionCalls('aiChat').length, 0); assert.equal(f.recorders.length, 0); assert.equal(f.microphoneCalls(), 0);
});
test('late capability from closed presence window cannot use a reopened window with the same photo', async () => {
  const caps = deferred(); let first = true;
  const f = presenceFixture({ api: (call, normal) => { if (call.action === 'aiCapabilities' && first) { first = false; return caps.promise; } return normal(call.action, call.data); } });
  const pending = f.context.MemoryAI.openFromPresence('m_2'); f.$('aiClose').click();
  await f.context.MemoryAI.open('m_2'); f.$('aiQuestion').value = '新窗口的草稿';
  caps.resolve({ text: true, vision: true, asr: true }); await pending;
  assert.equal(f.actionCalls('aiChat').length, 0); assert.equal(f.$('aiQuestion').value, '新窗口的草稿');
  assert.equal(f.$('aiReadPhoto').checked, false);
});
for (const [name, cancel] of Object.entries(cancelPresence)) test('late opening question cannot update the conversation after ' + name, async () => {
  const reply = deferred(); const f = presenceFixture({ api: (call, normal) => call.action === 'aiChat' ? reply.promise : normal(call.action, call.data) });
  const pending = f.context.MemoryAI.openFromPresence('m_2'); await settle();
  assert.equal(f.actionCalls('aiChat').length, 1); const request = f.actionCalls('aiChat')[0]; cancel(f);
  reply.resolve({ answer: '旧请求的回答是什么？', imageUsed: true }); await pending;
  assert.doesNotMatch(f.$('aiMessages')?.textContent || '', /旧请求的回答/);
  if (!['hidden before visibility notification', 'identity changed', 'session expired'].includes(name)) assert.equal(request.signal.aborted, true);
});
test('late opening question cannot overwrite a new conversation after reopening the same photo', async () => {
  const reply = deferred(); let first = true;
  const f = presenceFixture({ api: (call, normal) => { if (call.action === 'aiChat' && first) { first = false; return reply.promise; } return normal(call.action, call.data); } });
  const pending = f.context.MemoryAI.openFromPresence('m_2'); await settle();
  f.$('aiClose').click(); await f.context.MemoryAI.open('m_2'); await f.send('新窗口的问题');
  const text = f.$('aiMessages').textContent, note = f.$('aiStatus').textContent;
  reply.resolve({ answer: '旧请求的回答是什么？', imageUsed: true }); await pending;
  assert.equal(f.$('aiMessages').textContent, text); assert.equal(f.$('aiStatus').textContent, note);
});
for (const [name, response] of Object.entries({
  unavailable: () => ({ answer: '这张照片让您想起什么？', imageUsed: false }),
  malformed: () => ({ answer: '这是一张照片。您在哪里？', imageUsed: true }),
  empty: () => ({ answer: '', imageUsed: true }),
  failed: () => { throw Error('provider fixture unavailable'); }
})) test('presence ' + name + ' answer falls back to ordinary chat without automatic retry', async () => {
  const f = presenceFixture({ api: (call, normal) => call.action === 'aiChat' ? response() : normal(call.action, call.data) });
  const result = await f.context.MemoryAI.openFromPresence('m_2');
  assert.equal(result.outcome, 'fallback'); assert.equal(f.$('aiReadPhoto').checked, false);
  assert.equal(f.$('aiQuestion').disabled, false); assert.match(f.$('aiStatus').textContent, /普通对话/);
  assert.equal(f.actionCalls('aiChat').length, 1); assert.equal(f.recorders.length, 0);
});
for (const failed of [false, true]) test('presence capability ' + (failed ? 'failure' : 'without vision') + ' falls back and a capability retry stays manual', async () => {
  let first = true;
  const f = presenceFixture({ api: (call, normal) => { if (call.action === 'aiCapabilities' && first) { first = false; if (failed) throw Error('fixture network'); return { text: true, vision: false, asr: false }; } return normal(call.action, call.data); } });
  const result = await f.context.MemoryAI.openFromPresence('m_2');
  assert.equal(result.outcome, 'fallback'); assert.equal(f.actionCalls('aiChat').length, 0);
  assert.equal(f.$('aiReadPhoto').checked, false); assert.match(f.$('aiStatus').textContent, /普通对话/);
  await f.$('aiRetry').click(); assert.equal(f.actionCalls('aiChat').length, 0);
});
