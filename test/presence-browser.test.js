'use strict';
// Real headless Chrome against production UI; only API/media/visibility are doubles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

test('presence invitation lifecycle and owner controls in Chrome', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME
}, async t => {
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true });
  t.after(() => browser.close());
  const root = path.resolve(__dirname, '../server/public');
  const server = http.createServer(async (req, res) => {
    try {
      let name = new URL(req.url, 'http://localhost').pathname;
      if (['/family', '/frame'].includes(name)) name = '/index.html';
      const file = path.resolve(root, '.' + name);
      if (!file.startsWith(root + path.sep)) throw Error('outside root');
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#acd2d9"/><circle cx="750" cy="150" r="75" fill="#fff0b5"/><path d="M0 600L300 200L650 650L850 380L1000 600V700H0" fill="#639b80"/></svg>');
  let seq = 0;
  const event = () => ({ seq: ++seq, eventId: randomUUID(), type: 'presence.dwell', receivedAt: Date.now(), expiresAt: Date.now() + 15000 });
  async function fixture(role = 'frame') {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    const page = await context.newPage(), actions = [], errors = [], diagnostics = [];
    const snapshot = { room: { name: '驻足邀请验收' }, members: [], people: [], receipts: [], messages: [1, 2].map(n => ({ _id: 'm' + n, image: 'fixture-image-' + n, type: 'photo', imageURL: photo, title: '家庭照片 ' + n, createdAt: n, name: '家人' })) };
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().startsWith('[presence]')) diagnostics.push(message.text()); });
    await page.addInitScript(({ role }) => {
      const key = 'memory-session-' + (role === 'frame' ? 'frame' : 'family');
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ token: 'fixture', room: 'fixture-room', role, name: '家人' }));
      window.microphoneRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.microphoneRequests++; throw Error('No real microphone in fixture'); };
    }, { role });
    await page.route('**/api', route => {
      const request = route.request().postDataJSON(); actions.push(request);
      const responses = { state: { ...snapshot, serverTime: Date.now() }, receipt: { ok: true }, framePresence: { ok: true }, contactState: { members: [], requests: [] }, aiCapabilities: { text: true, vision: true, asr: true }, aiRealtimeCapabilities: { enabled: false }, logout: { ok: true },
        presenceSensorList: { frames: [{ id: 'frame-one', name: '客厅相框', online: true }], sensors: [{ deviceId: 'living-room-link2', targetFrameId: 'frame-one', active: true, targetAvailable: true }], eventTtlMs: 15000 },
        presenceSensorIssue: { token: 'synthetic-sensor-token-for-ui-test' }, presenceSensorRotate: { token: 'synthetic-rotated-token-for-ui-test' }, presenceSensorRevoke: { ok: true } };
      return route.fulfill({ json: responses[request.action] || {} });
    });
    await page.goto(origin + (role === 'frame' ? '/frame' : '/family'));
    await page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('家庭照片 2'));
    return { page, context, snapshot, actions, errors, diagnostics, async report(value = event()) { snapshot.presenceEvent = value; await page.evaluate(() => poll()); return value; }, async finish() { assert.deepEqual(errors, []); await context.close(); } };
  }
  await t.test('consent fixes trigger photo; no microphone, upload or AI request before consent', async () => {
    const f = await fixture(); try {
      await f.report(); await f.page.locator('#presenceInvitation').waitFor({ state: 'visible' });
      assert.equal(await f.page.evaluate(() => microphoneRequests), 0);
      assert.equal(f.actions.some(item => ['aiChat', 'aiTranscribe', 'aiRealtimeStart', 'upload'].includes(item.action)), false);
      f.snapshot.messages.push({ ...f.snapshot.messages[0], _id: 'm3', title: '新照片 3', createdAt: 3 });
      await f.page.evaluate(() => poll());
      assert.match(await f.page.locator('#caption').textContent(), /新照片 3/);
      await f.page.locator('#presenceAccept').click(); await f.page.locator('.ai-dialog').waitFor({ state: 'visible' });
      assert.match(await f.page.locator('#aiPhotos').textContent(), /家庭照片 2/);
      assert.equal(await f.page.locator('#aiReadPhoto').isChecked(), false);
      assert.equal(await f.page.evaluate(() => microphoneRequests), 0);
      await f.page.reload(); await f.page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('新照片 3'));
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      assert.ok(f.diagnostics.some(value => value.includes('duplicate')));
    } finally { await f.finish(); }
  });
  await t.test('state response delayed past expiry is consumed without extending the event lifetime', async () => {
    const f = await fixture(); try {
      const staleInTransit = event();
      staleInTransit.expiresAt = staleInTransit.receivedAt + 80;
      f.snapshot.presenceEvent = staleInTransit;
      let delayed = true;
      await f.page.route('**/api', async route => {
        if (route.request().postDataJSON().action !== 'state' || !delayed) return route.fallback();
        const response = { ...f.snapshot, serverTime: Date.now() };
        await new Promise(resolve => setTimeout(resolve, 250));
        return route.fulfill({ json: response });
      });
      await f.page.evaluate(() => poll());
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      assert.equal(f.diagnostics.some(value => value.includes('shown')), false);
      assert.ok(f.diagnostics.some(value => value.includes('expired')));
      delayed = false; await f.page.reload();
      await f.page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('家庭照片 2'));
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      assert.ok(f.diagnostics.some(value => value.includes('duplicate')));
    } finally { await f.finish(); }
  });
  await t.test('decline and existing invitation consume events without queueing', async () => {
    const f = await fixture(); try {
      await f.report(); await f.page.locator('#presenceInvitation').waitFor({ state: 'visible' });
      await f.report(); await f.page.locator('#presenceDecline').click();
      await f.page.evaluate(() => poll()); assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      await f.report(); await f.page.locator('#presenceInvitation').waitFor({ state: 'visible' });
      await f.page.keyboard.press('Escape'); assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
    } finally { await f.finish(); }
  });
  const gates = {
    recording: () => { recording = {}; },
    'microphone permission pending': () => { recordingStarting = true; },
    'original audio': () => { frameAudio = new Audio(); frameAudio.dataset.message = 'm2'; Object.defineProperty(frameAudio, 'paused', { value: false }); },
    'text AI': () => MemoryAI.open(),
    'realtime AI': () => MemoryRealtime.open(),
    'family call': () => { globalThis.MemoryCall = { busy: () => true }; },
    hidden: () => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); },
    'night clock': () => { localDisplay.night = true; Date.prototype.getHours = () => 23; applyLocalDisplay(); }
  };
  for (const [name, gate] of Object.entries(gates)) await t.test(name + ' consumes event before gate, including after reload', async () => {
    const f = await fixture(); try {
      await f.page.evaluate(gate); await f.report();
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      await f.page.reload(); await f.page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('家庭照片 2'));
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
    } finally { await f.finish(); }
  });
  for (const [name, change] of Object.entries({
    hidden: () => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); },
    busy: () => { recordingStarting = true; },
    deleted: () => { state.messages = []; },
    expired: () => { state.serverTime += 16000; },
    logout: () => expireSession('测试失效')
  })) await t.test('displayed invitation closes when ' + name, async () => {
    const f = await fixture(); try {
      await f.report(); await f.page.locator('#presenceInvitation').waitFor({ state: 'visible' });
      await f.page.evaluate(change); await f.page.locator('#presenceInvitation').waitFor({ state: 'detached' });
      assert.equal(await f.page.locator('.ai-dialog').count(), 0);
    } finally { await f.finish(); }
  });
  await t.test('no photo, expired event, revoked source and unavailable persistence fail closed', async () => {
    const f = await fixture(); try {
      const stale = event(); stale.receivedAt -= 20000; stale.expiresAt -= 20000; await f.report(stale);
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      f.snapshot.messages.forEach(message => { delete message.image; }); await f.report();
      assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      f.snapshot.messages.forEach(message => { message.image = 'image'; }); await f.report();
      await f.page.locator('#presenceInvitation').waitFor({ state: 'visible' });
      await f.report(null); assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      await f.page.evaluate(() => { Storage.prototype.setItem = () => { throw Error('blocked'); }; });
      await f.report(); assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
    } finally { await f.finish(); }
  });
  await t.test('owner controls bind target, reveal once, rotate, revoke and clear on close/background', async () => {
    const f = await fixture('owner'); try {
      await f.report(); assert.equal(await f.page.locator('#presenceInvitation').count(), 0);
      await f.page.locator('#settings').click(); await f.page.locator('#presenceSettingsEntry').click();
      await f.page.locator('#sensorIssue').waitFor({ state: 'visible' });
      await f.page.locator('#sensorIssue').click(); await f.page.locator('#presenceSensorToken').waitFor();
      assert.deepEqual(f.actions.find(item => item.action === 'presenceSensorIssue').data, { deviceId: 'living-room-link2', targetFrameId: 'frame-one' });
      assert.equal(await f.page.locator('#presenceSensorToken').getAttribute('type'), 'password');
      assert.equal(await f.page.evaluate(() => Object.values(localStorage).some(value => value.includes('synthetic-sensor-token'))), false);
      f.page.on('dialog', dialog => dialog.accept());
      await f.page.locator('[data-sensor-rotate]').click(); await f.page.waitForFunction(() => document.querySelector('#presenceSensorToken')?.value.includes('rotated'));
      await f.page.locator('[data-sensor-revoke]').click(); await f.page.waitForFunction(() => document.querySelector('#sensorStatus')?.textContent.includes('已停用'));
      assert.equal(await f.page.locator('#presenceSensorToken').count(), 0);
      await f.page.locator('#sensorIssue').click(); await f.page.locator('#presenceSensorToken').waitFor();
      await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal(await f.page.locator('#presenceSettings').count(), 0);
      assert.deepEqual(await f.page.locator('.family-tabbar button').evaluateAll(items => items.map(item => item.id)), ['homeTab', 'plus', 'mineTab']);
    } finally { await f.finish(); }
  });
  await t.test('late issue response cannot reveal a token after background or session expiry', async () => {
    for (const reason of ['background', 'expired']) {
      const f = await fixture('owner'); let release;
      try {
        let started; const pending = new Promise(resolve => { started = resolve; });
        const wait = new Promise(resolve => { release = resolve; });
        await f.page.route('**/api', async route => {
          if (route.request().postDataJSON().action !== 'presenceSensorIssue') return route.fallback();
          started(); await wait;
          try { await route.fulfill({ json: { token: 'late-synthetic-secret' } }); } catch { /* Request was deliberately aborted. */ }
        });
        await f.page.locator('#settings').click(); await f.page.locator('#presenceSettingsEntry').click();
        await f.page.locator('#sensorIssue').click(); await pending;
        if (reason === 'background') await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
        else await f.page.evaluate(() => expireSession('fixture'));
        release(); await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await f.page.locator('#presenceSettings').count(), 0);
        assert.equal(await f.page.evaluate(() => document.body.textContent.includes('late-synthetic-secret') || Object.values(localStorage).some(value => value.includes('late-synthetic-secret'))), false);
      } finally { release?.(); await f.finish(); }
    }
  });
  for (const reason of ['session expiry', 'rejoin', 'background']) await t.test('late family microphone permission is released after ' + reason, async () => {
    const f = await fixture(); try {
      await f.page.evaluate(() => {
        window.stoppedTracks = 0;
        navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.finishPermission = () => resolve({ getTracks: () => [{ stop: () => window.stoppedTracks++ }] }); });
        window.recordingStart = startRecording();
      });
      if (reason === 'session expiry') await f.page.evaluate(() => expireSession('fixture'));
      else if (reason === 'rejoin') await f.page.evaluate(() => rejoinSession());
      else await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await f.page.evaluate(async () => { finishPermission(); await recordingStart; });
      assert.deepEqual(await f.page.evaluate(() => ({ stopped: stoppedTracks, recording: !!recording, pending: recordingStarting })), { stopped: 1, recording: false, pending: false });
    } finally { await f.finish(); }
  });
  await t.test('session expiry during audio context resume releases stream and context', async () => {
    const f = await fixture(); try {
      await f.page.evaluate(() => {
        window.stoppedTracks = 0; window.closedContexts = 0;
        navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => window.stoppedTracks++ }] });
        window.AudioContext = class { resume() { return new Promise(resolve => { window.finishResume = resolve; }); } async close() { window.closedContexts++; } };
        window.recordingStart = startRecording();
      });
      await f.page.waitForFunction(() => typeof finishResume === 'function');
      await f.page.evaluate(async () => { expireSession('fixture'); finishResume(); await recordingStart; });
      assert.deepEqual(await f.page.evaluate(() => ({ stopped: stoppedTracks, closed: closedContexts, recording: !!recording })), { stopped: 1, closed: 1, recording: false });
    } finally { await f.finish(); }
  });
  await t.test('audio setup failure releases resources before recording is installed', async () => {
    const f = await fixture(); try {
      const result = await f.page.evaluate(async () => {
        window.stoppedTracks = 0; window.closedContexts = 0;
        navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => window.stoppedTracks++ }] });
        window.AudioContext = class { async resume() {} createMediaStreamSource() { throw Error('fixture setup failure'); } async close() { window.closedContexts++; } };
        await startRecording(); return { stopped: stoppedTracks, closed: closedContexts, recording: !!recording, pending: recordingStarting };
      });
      assert.deepEqual(result, { stopped: 1, closed: 1, recording: false, pending: false });
    } finally { await f.finish(); }
  });
  await t.test('late cancelled permission cannot clear a newer permission gate', async () => {
    const f = await fixture(); try {
      const result = await f.page.evaluate(async () => {
        const waits = []; let stopped = 0;
        navigator.mediaDevices.getUserMedia = () => new Promise(resolve => waits.push(() => resolve({ getTracks: () => [{ stop: () => stopped++ }] })));
        const first = startRecording(); cancelRecordingStart(); const second = startRecording();
        waits[0](); await first; const newerPending = recordingStarting;
        expireSession('fixture'); waits[1](); await second;
        return { newerPending, stopped, pending: recordingStarting, recording: !!recording };
      });
      assert.deepEqual(result, { newerPending: true, stopped: 2, pending: false, recording: false });
    } finally { await f.finish(); }
  });
  for (const role of ['family', 'frame']) await t.test(role + ' cannot see owner sensor controls', async () => {
    const f = await fixture(role); try {
      if (role === 'frame') await f.page.locator('#frameMenu summary').click();
      await f.page.locator('#settings').click(); assert.equal(await f.page.locator('#presenceSettingsEntry').count(), 0);
    } finally { await f.finish(); }
  });
  t.diagnostic(`Chrome ${await browser.version()}; API, images and visibility doubles; no real camera, microphone or AI supplier.`);
});
