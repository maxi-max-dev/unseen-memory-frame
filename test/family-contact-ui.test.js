'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server/public/family-contact.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (overrides = {}) => ({ members: [{ id: 'u_family', name: '家人', role: 'family', recentlySeen: true }], requests: [], incomingCount: 0, ...overrides });

function fixture() {
  const nodes = new Map(), timers = new Map(), calls = [], events = new Map(); let timerId = 0;
  function element(tag = 'div') {
    const children = new Map(), listeners = new Map();
    return { tagName: tag.toUpperCase(), dataset: {}, value: 'u_family', open: false, hidden: false, innerHTML: '', textContent: '',
      setAttribute() {}, append(child) { nodes.set(child.id, child); }, replaceChildren() { this.innerHTML = ''; }, contains: () => false,
      querySelector(selector) { if (!children.has(selector)) children.set(selector, element(selector === 'select' ? 'select' : 'div')); return children.get(selector); },
      querySelectorAll() { return []; }, addEventListener(name, fn) { listeners.set(name, fn); },
      showModal() { this.open = true; }, close() { this.open = false; listeners.get('close')?.(); },
      click(action, id) { listeners.get('click')?.({ target: { closest: () => ({ dataset: { action, id } }) } }); }, focus() {} };
  }
  const context = vm.createContext({ session: { token: 'session-one' }, sessionExpired: false, AbortController, console,
    crypto: { randomUUID: () => 'test-request-uuid' },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    document: { hidden: false, body: element('body'), activeElement: null, createElement: element },
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    api(action, data, auth, { signal }) { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ action, data, auth, signal, resolve, reject }); return promise; }
  });
  vm.runInContext(source, context);
  return { context, calls, nodes, timers, events, api: context.window.MemoryContact,
    dialog: () => nodes.get('familyContactDialog'), content: () => nodes.get('familyContactDialog').querySelector('[data-content]'),
    status: () => nodes.get('familyContactDialog').querySelector('.contact-status') };
}

test('contact UI only reads state until an explicit click; requests reuse their id after an uncertain result', async () => {
  const f = fixture(); f.api.open(); assert.equal(f.calls[0].action, 'contactState');
  f.calls[0].resolve(snapshot()); await tick();
  f.dialog().click('request'); assert.equal(f.calls[1].action, 'contactRequest');
  const data = f.calls[1].data;
  assert.equal(data.targetId, 'u_family'); assert.equal(f.calls[1].auth, 'session-one');
  f.calls[1].reject(new Error('网络中断')); await tick(); assert.equal(f.status().dataset.error, 'true');
  f.dialog().click('request'); assert.deepEqual(f.calls[2].data, data);
  f.calls[2].resolve(snapshot()); await tick(); assert.match(f.status().textContent, /请求已保存.*等待对方/);
});

test('closing aborts pending work and prevents a late response repainting the closed dialog', async () => {
  const f = fixture(); f.api.open(); f.dialog().close();
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve(snapshot({ members: [{ id: 'secret', name: '不应出现', role: 'family' }] })); await tick();
  assert.doesNotMatch(f.content().innerHTML, /不应出现/);
  f.api.open(); assert.equal(f.calls.length, 2); f.calls[1].resolve(snapshot()); await tick();
  assert.equal(f.dialog().open, true); assert.match(f.content().innerHTML, /家人/);
});

test('session disposal clears private contact state and aborts a pending mutation', async () => {
  const f = fixture(); f.api.open(); f.calls[0].resolve(snapshot()); await tick();
  f.dialog().click('request'); f.api.dispose();
  assert.equal(f.calls[1].signal.aborted, true); assert.equal(f.dialog().open, false); assert.equal(f.content().innerHTML, '');
  f.context.session = { token: 'session-two' }; f.api.open();
  f.calls[1].resolve(snapshot({ members: [{ id: 'old', name: '旧账号家人', role: 'family' }] })); await tick();
  assert.doesNotMatch(f.content().innerHTML, /旧账号/); assert.equal(f.calls[2].auth, 'session-two');
  f.calls[2].resolve(snapshot()); await tick(); assert.equal(f.dialog().open, true);
});

test('a state read started before a response cannot overwrite the newer saved acknowledgement', async () => {
  const f = fixture(); f.api.open(); f.calls[0].resolve(snapshot()); await tick();
  const checking = f.api.refresh(true); const stale = f.calls[1];
  f.dialog().click('acknowledge', 'c_request'); const saved = f.calls[2];
  assert.equal(stale.signal.aborted, true); assert.equal(saved.action, 'contactRespond');
  const contact = { id: 'c_request', direction: 'incoming', from: { name: '家人' }, to: { name: '我' }, createdAt: Date.now() };
  saved.resolve(snapshot({ requests: [{ ...contact, status: 'acknowledged' }] })); await tick();
  stale.resolve(snapshot({ requests: [{ ...contact, status: 'pending' }], incomingCount: 1 })); await checking;
  assert.match(f.content().innerHTML, /你已确认收到/); assert.doesNotMatch(f.content().innerHTML, /等待你的回应/);
});

test('background state refresh only shows an in-page reminder, and pauses when hidden or logged out', async () => {
  const f = fixture(); const first = f.api.refresh(); f.calls[0].resolve(snapshot({ incomingCount: 1 })); await first;
  const notice = f.nodes.get('familyContactNotice'); assert.equal(f.dialog().open, false); assert.equal(notice.hidden, false); assert.match(notice.textContent, /家人想联系你/);
  f.context.document.hidden = true; await f.api.refresh(); assert.equal(f.calls.length, 1);
  f.context.sessionExpired = true; await f.api.refresh(); assert.equal(notice.hidden, true); assert.equal(f.content().innerHTML, '');
});

test('contact request timeout has a real retry message and pagehide releases pending requests', async () => {
  const f = fixture(); f.api.open();
  const timeout = [...f.timers.values()].find(item => item.ms === 15000); timeout.fn();
  assert.equal(f.calls[0].signal.aborted, true);
  const error = new Error('aborted'); error.name = 'AbortError'; f.calls[0].reject(error); await tick();
  assert.equal(f.status().dataset.error, 'true'); assert.match(f.status().textContent, /读取超时/);
  const next = f.api.refresh(true); f.events.get('pagehide')(); assert.equal(f.calls[1].signal.aborted, true);
  f.calls[1].reject(error); await next; assert.equal(f.dialog().open, false);
});
