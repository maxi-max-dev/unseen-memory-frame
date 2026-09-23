'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');

test('frame presentation, real HTTP and Chrome with isolated synthetic memories', { skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-presentation-'));
  const app = await createApp({ store: new LocalStore(directory), setupCode: 'local-frame-only', call: { env: {} }, conversation: { capabilities: () => ({ text: true, vision: true, asr: false }), complete: () => { throw Error('Unexpected model use'); } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => app.server.close(resolve)); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('frame-presentation-')); await fs.rm(directory, { recursive: true, force: true }); });
  async function api(action, data = {}, token = '') { const response = await fetch(origin + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, data }) }); assert.equal(response.status, 200, action); return response.json(); }
  const owner = await api('create', { setupCode: 'local-frame-only', name: '家里的好时光' });
  const invitation = await api('invite', { role: 'frame' }, owner.token);
  const frameSession = await api('join', { invite: invitation.invite, nickname: '客厅相框' });
  const errors = [], actions = [];
  async function open(session, viewport = { width: 1180, height: 820 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(session => {
      localStorage.setItem('memory-session-' + (session.role === 'frame' ? 'frame' : 'family'), JSON.stringify(session));
      window.microphoneCount = 0; navigator.mediaDevices.getUserMedia = async () => { window.microphoneCount++; throw Error('No microphone in test'); };
    }, session);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url() === origin + '/api' && request.method() === 'POST') actions.push(request.postDataJSON().action); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + (session.role === 'frame' ? '/frame' : '/family'));
    await page.waitForFunction(() => document.querySelector('#roomName')?.textContent === '家里的好时光');
    return page;
  }
  const ownerPage = await open(owner);
  const picture = await ownerPage.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 1000; const c = canvas.getContext('2d');
    const sky = c.createLinearGradient(0, 0, 0, 1000); sky.addColorStop(0, '#c3d3c1'); sky.addColorStop(1, '#efe4bf'); c.fillStyle = sky; c.fillRect(0, 0, 1400, 1000);
    c.fillStyle = '#efc887'; c.beginPath(); c.arc(1020, 230, 100, 0, 7); c.fill();
    for (const [color, x, y] of [['#748f73', 480, 330], ['#536f59', 1150, 520]]) { c.fillStyle = color; c.beginPath(); c.moveTo(x - 700, 1000); c.lineTo(x, y); c.lineTo(x + 700, 1000); c.fill(); }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const image = await api('upload', { base64: picture }, owner.token);
  const wav = Buffer.alloc(44 + 32000); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  const audio = await api('upload', { base64: wav.toString('base64') }, owner.token);
  for (const [id, title] of [['one', '山里的午后'], ['two', '一起去看远方'], ['three', '把好天气寄给您']]) await api('send', { id, image: image.id, audio: audio.id, duration: 1, title, text: '有空的时候，和我们说说今天吧。' }, owner.token);
  const page = await open(frameSession);
  const screenshots = process.env.AI_UX_SCREENSHOTS;
  if (screenshots) await fs.mkdir(screenshots, { recursive: true });
  await page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('好天气'));
  assert.equal(await page.locator('#frameSlideshow').getAttribute('aria-pressed'), 'false');
  await page.locator('#frameMenu summary').click();
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'frame-advanced-1180.png') });
  assert.match(await page.locator('#frameSpatialNote').textContent(), /当前照片没有/);
  assert.match(await page.locator('#frameSpatialChoices').textContent(), /还没有/);
  await page.locator('#openFamilyCall').click(); await page.waitForFunction(() => document.querySelector('#callCapability')?.textContent.includes('尚未启用'));
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'frame-call-unavailable.png') });
  assert.equal(await page.locator('#callStart').isDisabled(), true); assert.equal(await page.evaluate(() => microphoneCount), 0);
  await page.evaluate(async () => { await MemoryAI.open(); await MemoryRealtime.open(); await startRecording(); });
  assert.equal(await page.locator('.ai-dialog[open]').count(), 0); assert.equal(await page.evaluate(() => microphoneCount), 0);
  await page.locator('#callReminder').click(); assert.equal(await page.locator('#familyContactDialog').count() > 0, true);
  await page.keyboard.press('Escape');
  await page.locator('#frameMenu summary').click(); await page.locator('#aiHomeChat').click();
  assert.match(await page.locator('#aiPhotos').textContent(), /把好天气/); assert.equal(await page.locator('#aiReadPhoto').isChecked(), false); await page.locator('#aiClose').click();
  // Actual UI path with a controlled, unresolved permission request: no second
  // recorder or AI capability request can be opened while family recording starts.
  const capabilityRequests = actions.filter(action => ['aiCapabilities', 'aiRealtimeCapabilities'].includes(action)).length;
  await page.evaluate(() => { window.previousMicrophone = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = () => { microphoneCount++; return new Promise((resolve, reject) => { window.rejectFramePermission = reject; }); }; });
  await page.locator('#record').click(); await page.waitForFunction(() => recordingStarting);
  await page.locator('#frameMenu summary').click(); await page.locator('#aiHomeChat').click();
  assert.equal(await page.locator('.ai-dialog[open]').count(), 0);
  await page.locator('#frameMenu summary').click(); await page.locator('#aiHomeLive').click();
  assert.equal(await page.locator('.ai-dialog[open]').count(), 0); assert.equal(await page.evaluate(() => microphoneCount), 1);
  assert.equal(actions.filter(action => ['aiCapabilities', 'aiRealtimeCapabilities'].includes(action)).length, capabilityRequests);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = previousMicrophone; rejectFramePermission(Object.assign(Error('Test permission declined'), { name: 'NotAllowedError' })); });
  await page.waitForFunction(() => !recordingStarting);
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const [width, height] of [[1180, 820], [1024, 768], [820, 1180], [390, 844]]) {
    await page.setViewportSize({ width, height });
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `frame-normal-${width}.png`) });
    await page.locator('#framePresentation').click();
    assert.equal(await page.locator('body').evaluate(element => element.classList.contains('frame-presenting')), true);
    assert.equal(await page.locator('header').isVisible(), false);
    for (const id of ['record', 'listen', 'prev', 'next', 'framePresentation', 'frameSlideshow']) {
      const box = await page.locator('#' + id).boundingBox(); assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, id);
    }
    assert.equal(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `frame-show-${width}.png`) });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('header').isVisible(), true);
  }
  // Leaving the simplified presentation restores the real advanced entry path.
  await page.locator('#framePresentation').click(); await page.locator('#framePresentation').click();
  await page.locator('#frameMenu summary').click(); await page.locator('#aiHomeChat').click();
  assert.equal(await page.locator('.ai-dialog[open]').count(), 1); await page.locator('#aiClose').click();
  // Use the real local-display function across 22:00. Presentation temporarily
  // suspends night mode without persisting a preference change, then restores it.
  await page.clock.install({ time: new Date('2026-09-24T21:59:50') });
  await page.evaluate(() => { localDisplay.night = true; persistDisplay(); });
  await page.locator('#framePresentation').click(); await page.clock.fastForward(20000);
  await page.evaluate(() => applyLocalDisplay());
  assert.equal(await page.locator('#nightClock').isVisible(), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('memory-display-v1')).night), true);
  await page.locator('#framePresentation').click();
  assert.equal(await page.locator('#nightClock').isVisible(), true);
  assert.equal(await page.evaluate(() => localDisplay.night), true);
  await page.evaluate(() => { localDisplay.night = false; persistDisplay(); });
  await page.setViewportSize({ width: 1180, height: 820 }); await page.locator('#framePresentation').click();
  await page.locator('#frameFullscreen').click();
  const fullscreenEntered = await page.evaluate(() => document.fullscreenElement === document.documentElement);
  if (fullscreenEntered) {
    await page.evaluate(() => MemoryAI.open(current()._id)); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ai-dialog[open]').count(), 0);
    assert.equal(await page.locator('body').evaluate(element => element.classList.contains('frame-presenting')), true);
    await page.evaluate(() => document.exitFullscreen()); await page.waitForFunction(() => !document.body.classList.contains('frame-presenting'));
  }
  else await page.locator('#framePresentation').click();
  await page.locator('#framePresentation').click();
  await page.evaluate(() => MemoryAI.open(current()._id)); await page.keyboard.press('Escape');
  assert.equal(await page.locator('body').evaluate(element => element.classList.contains('frame-presenting')), true);
  assert.equal(await page.locator('.ai-dialog[open]').count(), 0);
  await page.evaluate(() => { document.documentElement.requestFullscreen = async () => { throw Error('Denied fixture'); }; });
  await page.locator('#frameFullscreen').click(); assert.match(await page.locator('#frameSlideshowStatus').textContent(), /全屏不可用/);
  const selectedId = () => page.evaluate(() => selected);
  await page.locator('#frameSlideshow').click(); const first = await selectedId();
  await page.clock.fastForward(15100); assert.notEqual(await selectedId(), first);
  await page.locator('#next').click(); const manual = await selectedId();
  await page.clock.fastForward(14000); assert.equal(await selectedId(), manual);
  await page.clock.fastForward(1200); assert.notEqual(await selectedId(), manual);
  for (const gate of ['recordingStarting', 'recording', 'draft', 'audio', 'ai', 'call', 'dialog', 'hidden', 'night']) {
    await page.evaluate(gate => {
      window.restoreFrameGate = () => {};
      if (gate === 'recordingStarting') { recordingStarting = true; restoreFrameGate = () => { recordingStarting = false; }; }
      if (gate === 'recording') { recording = {}; restoreFrameGate = () => { recording = null; }; }
      if (gate === 'draft') { draft.audio = new Blob(['fixture']); restoreFrameGate = () => { delete draft.audio; }; }
      if (gate === 'audio') { frameAudio = new Audio(); Object.defineProperty(frameAudio, 'paused', { value: false }); restoreFrameGate = () => { frameAudio = null; }; }
      if (gate === 'ai' || gate === 'call') { const key = gate === 'ai' ? 'MemoryAI' : 'MemoryCall', previous = globalThis[key]; globalThis[key] = { ...previous, busy: () => true }; restoreFrameGate = () => { globalThis[key] = previous; }; }
      if (gate === 'dialog') { const dialog = document.createElement('dialog'); dialog.id = 'fixtureBusyDialog'; document.body.append(dialog); dialog.showModal(); restoreFrameGate = () => dialog.remove(); }
      if (gate === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); restoreFrameGate = () => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); }; }
      if (gate === 'night') { document.documentElement.classList.add('night-view'); restoreFrameGate = () => document.documentElement.classList.remove('night-view'); }
      MemoryFramePresentation.refresh();
    }, gate);
    const before = await selectedId(); await page.clock.fastForward(31000); assert.equal(await selectedId(), before, gate);
    await page.evaluate(() => { restoreFrameGate(); MemoryFramePresentation.refresh(); });
    await page.clock.fastForward(14000); assert.equal(await selectedId(), before, gate + ' no catchup');
    await page.clock.fastForward(1300); assert.notEqual(await selectedId(), before, gate + ' resumes');
  }
  await page.locator('#framePresentation').click(); const stopped = await selectedId(); await page.clock.fastForward(31000); assert.equal(await selectedId(), stopped);
  assert.equal(await page.locator('#frameSlideshow').getAttribute('aria-pressed'), 'false');
  const memories = (await api('state', {}, owner.token)).messages;
  for (const message of memories.slice(1)) await api('remove', { id: message._id }, owner.token);
  await page.evaluate(() => poll()); assert.equal(await page.locator('#frameSlideshow').isDisabled(), true);
  await api('remove', { id: memories[0]._id }, owner.token); await page.evaluate(() => poll());
  assert.equal(await page.locator('#frameSlideshow').isDisabled(), true); assert.match(await page.locator('#photo').textContent(), /还没有照片/);
  await page.locator('#framePresentation').click(); await page.evaluate(() => expireSession('本地验收失效'));
  assert.equal(await page.locator('header').isVisible(), true); assert.equal(await page.locator('#rejoinSession').isVisible(), true);
  assert.equal(await page.locator('#framePresentationControls').count(), 0);
  await ownerPage.locator('#openFamilyCall').click(); await ownerPage.waitForFunction(() => document.querySelector('#callStart')?.disabled);
  assert.deepEqual(await ownerPage.locator('.family-tabbar button').evaluateAll(elements => elements.map(element => element.id)), ['homeTab', 'plus', 'mineTab']);
  assert.equal(actions.some(action => ['callStart', 'callAccept', 'aiChat', 'aiRealtimeStart'].includes(action)), false);
  assert.deepEqual(errors, []);
  t.diagnostic(`Chrome ${await browser.version()}; actual HTTP/LocalStore and uploaded synthetic PNG; clock and busy/media gates controlled in browser, no real microphone/call/model/hardware/GPU claim.`);
});
