'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'call-readiness-')), env = {};
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'local-call-readiness', call: { env }, realtime: { env: {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('call-readiness-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function api(action, data = {}, token, expected = 200) {
    const response = await fetch(origin + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') }, body: JSON.stringify({ action, data }) });
    assert.equal(response.status, expected, action); return response.json();
  }
  const owner = await api('create', { setupCode: 'local-call-readiness', name: '本地通话验证' });
  const invitation = await api('invite', { role: 'frame' }, owner.token);
  const frame = await api('join', { invite: invitation.invite, nickname: '本地测试相框' });
  return { env, origin, api, owner, frame };
}

test('real LocalStore HTTP: disabled reasons, recipient-only acceptance and cross-family isolation', async t => {
  const f = await fixture(t), { api, owner, frame, env } = f;
  const caps = await api('callCapabilities', {}, owner.token);
  assert.equal(caps.enabled, false); assert.match(caps.reason, /尚未启用/); assert.equal(caps.backgroundPush, false);
  assert.equal('iceServers' in caps, false); assert.equal('secret' in caps, false);
  const state = await api('callState', {}, owner.token), target = state.members.find(item => item.role === 'frame'); assert.ok(target);
  await api('callStart', { targetId: target.id, requestId: 'unconfigured-call' }, owner.token, 503);
  await api('callState', {}, undefined, 401);
  // Explicit synthetic localhost-only configuration exercises signalling permissions;
  // no browser is given credentials, and no TURN server or microphone is contacted.
  Object.assign(env, { MEMORY_CALL_ENABLED: '1', MEMORY_CALL_ICE_SERVERS_JSON: JSON.stringify([{ urls: 'turns:example.invalid:5349' }]), MEMORY_CALL_TURN_SECRET: 'local-test-placeholder-never-a-real-turn-key' });
  const started = await api('callStart', { targetId: target.id, requestId: 'configured-local-call' }, owner.token);
  await api('callAccept', { id: started.callId }, owner.token, 403);
  const outside = await api('create', { setupCode: 'local-call-readiness', name: '另一隔离家庭' });
  assert.deepEqual((await api('callState', {}, outside.token)).calls, []);
  await api('callState', { id: started.callId }, outside.token, 404);
  await api('callAccept', { id: started.callId }, outside.token, 404);
  const accepted = await api('callAccept', { id: started.callId }, frame.token); assert.equal(accepted.call.status, 'accepted');
  await api('logout', {}, frame.token);
  await api('callState', { id: started.callId }, frame.token, 401);
  const ended = await api('callState', { id: started.callId }, owner.token);
  assert.equal(ended.call.status, 'failed'); assert.equal('peer' in ended.call, false);
});

test('real HTTP and Chrome: manually wired unavailable family/frame call entry requests no microphone or RTC', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME
}, async t => {
  const { origin, owner, frame } = await fixture(t);
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true });
  t.after(() => browser.close());
  const errors = [], actions = [];
  for (const session of [owner, frame]) {
    const context = await browser.newContext();
    await context.addInitScript(session => {
      localStorage.setItem('memory-session-' + (session.role === 'frame' ? 'frame' : 'family'), JSON.stringify(session));
      globalThis.callMediaRequests = { microphone: 0, rtc: 0, notification: 0 };
      navigator.mediaDevices.getUserMedia = async () => { callMediaRequests.microphone++; throw Error('No actual microphone in readiness test'); };
      globalThis.RTCPeerConnection = function () { callMediaRequests.rtc++; throw Error('No actual RTC in readiness test'); };
      if (globalThis.Notification) Notification.requestPermission = async () => { callMediaRequests.notification++; return 'denied'; };
    }, session);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url() === origin + '/api' && request.method() === 'POST') actions.push(request.postDataJSON().action); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + (session.role === 'frame' ? '/frame' : '/family'));
    await page.waitForFunction(() => typeof state !== 'undefined' && state !== null);
    // The base revision intentionally has no index/poll registration. Load only
    // the real module for this bounded test; this is not production UI integration.
    if (!await page.evaluate(() => !!globalThis.MemoryCall)) await page.addScriptTag({ url: origin + '/family-call.js' });
    await page.evaluate(() => MemoryCall.open());
    await page.locator('#callRecipient').selectOption({ index: 1 });
    assert.equal(await page.locator('#callStart').isDisabled(), true);
    assert.match(await page.locator('#callCapability').textContent(), /家庭语音通话尚未启用/);
    assert.deepEqual(await page.evaluate(() => callMediaRequests), { microphone: 0, rtc: 0, notification: 0 });
    await page.locator('#callReminder').click();
    assert.equal(await page.locator('#familyCallDialog').evaluate(element => element.open), false);
    assert.equal(actions.includes('callStart'), false); assert.equal(actions.includes('callIce'), false); assert.equal(actions.includes('contactRequest'), false);
    await context.close();
  }
  assert.deepEqual(errors, []);
});
