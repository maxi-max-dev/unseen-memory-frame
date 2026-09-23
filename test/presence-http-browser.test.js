'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');

test('real HTTP and Chrome: confirmed presence asks about fixed photo once and falls back safely', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presence-http-browser-'));
  const providerInputs = []; let providerFails = false;
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'presence-local-only',
    conversation: { capabilities: () => ({ text: true, vision: true, asr: false }), complete: async input => {
      providerInputs.push({ messageIds: input.messageIds, history: input.history, images: input.images.length });
      if (providerFails) throw Error('AI fixture unavailable');
      return { answer: input.history.length ? '谢谢您分享这段回忆。' : '这张照片让您想起了什么？', action: null };
    } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true });
  t.after(async () => {
    await browser.close(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('presence-http-browser-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function api(action, data = {}, token) {
    const response = await fetch(origin + '/api', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '')
    }, body: JSON.stringify({ action, data }) });
    assert.equal(response.status, 200, action); return response.json();
  }
  const owner = await api('create', { setupCode: 'presence-local-only', name: '本地联调家庭' });
  async function pair(name) { const invite = await api('invite', { role: 'frame' }, owner.token); return api('join', { invite: invite.invite, nickname: name }); }
  const targetFrame = await pair('客厅平板'), otherFrame = await pair('另一台相框');
  const errors = [], actions = [];
  async function pageFor(session, viewport) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ session }) => {
      const key = 'memory-session-' + (session.role === 'frame' ? 'frame' : 'family');
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(session));
      window.microphoneRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.microphoneRequests++; throw Error('No microphone in HTTP fixture'); };
    }, { session });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url() === origin + '/api' && request.method() === 'POST') actions.push(request.postDataJSON().action); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    return page;
  }
  const ownerPage = await pageFor(owner, { width: 390, height: 844 });
  await ownerPage.goto(origin + '/family');
  // Synthetic landscape is made in a fresh browser canvas, then actually uploaded
  // through the production upload API. No private family photo enters this test.
  const imageBase64 = await ownerPage.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 700;
    const context = canvas.getContext('2d'); context.fillStyle = '#bddde2'; context.fillRect(0, 0, 1000, 700);
    context.fillStyle = '#fff0b5'; context.beginPath(); context.arc(790, 145, 70, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#739e88'; context.beginPath(); context.moveTo(0, 700); context.lineTo(320, 220); context.lineTo(680, 700); context.fill();
    context.fillStyle = '#527c68'; context.beginPath(); context.moveTo(480, 700); context.lineTo(820, 350); context.lineTo(1000, 590); context.lineTo(1000, 700); context.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const image = await api('upload', { base64: imageBase64 }, owner.token);
  for (const [id, text] of [['first', '周末的山间散步'], ['second', '一起看看今天的风景']]) await api('send', { id, image: image.id, text, title: text }, owner.token);
  await ownerPage.evaluate(() => poll());
  await ownerPage.locator('#settings').click(); await ownerPage.locator('#presenceSettingsEntry').click();
  const list = await api('presenceSensorList', {}, owner.token);
  const target = list.frames.find(item => item.name === '客厅平板'); assert.ok(target);
  await ownerPage.locator('#sensorFrame').selectOption(target.id);
  await ownerPage.locator('#sensorIssue').click(); await ownerPage.locator('#presenceSensorToken').waitFor();
  const token = await ownerPage.locator('#presenceSensorToken').inputValue();
  assert.ok(token); await ownerPage.locator('#sensorClose').click();
  const framePage = await pageFor(targetFrame, { width: 1180, height: 820 });
  const otherPage = await pageFor(otherFrame, { width: 1180, height: 820 });
  await Promise.all([framePage.goto(origin + '/frame'), otherPage.goto(origin + '/frame')]);
  await framePage.waitForFunction(() => document.querySelector('#photo img')?.complete && document.querySelector('#caption')?.textContent.includes('今天的风景'));
  const makeEvent = () => ({ version: 1, eventId: randomUUID(), source: 'link2-windows', deviceId: 'living-room-link2', type: 'presence.dwell', occurredAt: Date.now(), dwellMs: 4200, headCount: 1 });
  const first = makeEvent(), accepted = await api('presenceReport', first, token);
  assert.equal(accepted.accepted, true); assert.equal(accepted.eventId, first.eventId);
  await framePage.locator('#presenceInvitation').waitFor({ state: 'visible', timeout: 7000 });
  assert.equal((await api('state', {}, owner.token)).presenceEvent, undefined);
  assert.equal((await api('state', {}, otherFrame.token)).presenceEvent, undefined);
  await otherPage.evaluate(() => poll()); assert.equal(await otherPage.locator('#presenceInvitation').count(), 0);
  const duplicate = await api('presenceReport', first, token); assert.equal(duplicate.seq, accepted.seq);
  await framePage.reload(); await framePage.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('今天的风景'));
  assert.equal(await framePage.locator('#presenceInvitation').count(), 0);

  await api('presenceReport', makeEvent(), token);
  await framePage.locator('#presenceInvitation').waitFor({ state: 'visible', timeout: 7000 });
  assert.equal(providerInputs.length, 0);
  assert.match(await framePage.locator('#presenceInvitationNote').textContent(), /确认后.*读取/);
  const screenshots = process.env.AI_UX_SCREENSHOTS;
  if (screenshots) {
    await fs.mkdir(screenshots, { recursive: true });
    for (const [width, height] of [[1180, 820], [820, 1180]]) {
      await framePage.setViewportSize({ width, height });
      for (const id of ['presenceAccept', 'presenceDecline']) {
        const box = await framePage.locator('#' + id).boundingBox();
        assert.ok(box && box.width >= 150 && box.height >= 70 && box.y >= 0 && box.y + box.height <= height);
      }
      assert.equal(await framePage.locator('#presenceInvitation').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      await framePage.screenshot({ path: path.join(screenshots, `presence-invitation-${width}.png`) });
    }
  }
  await api('send', { id: 'third', image: image.id, text: '后来寄来的照片', title: '后来寄来的照片' }, owner.token);
  await framePage.evaluate(() => poll()); assert.match(await framePage.locator('#caption').textContent(), /后来寄来/);
  await framePage.locator('#presenceAccept').click(); await framePage.locator('.ai-dialog').waitFor({ state: 'visible' });
  await framePage.waitForFunction(() => document.querySelector('#aiMessages')?.textContent.includes('这张照片让您想起了什么？'));
  assert.deepEqual(await framePage.locator('#aiMessages p').allTextContents(), ['AI：这张照片让您想起了什么？']);
  const second = (await api('state', {}, targetFrame.token)).messages.find(item => item.text === '一起看看今天的风景');
  assert.equal(await framePage.locator('#aiPhotos img').getAttribute('src'), second.imageURL);
  assert.match(await framePage.locator('#aiPhotos').textContent(), /一起看看今天的风景/);
  assert.doesNotMatch(await framePage.locator('#aiPhotos').textContent(), /后来寄来/);
  assert.equal(await framePage.locator('#aiReadPhoto').isChecked(), true);
  assert.equal(providerInputs.length, 1); assert.deepEqual(providerInputs[0].messageIds, [second._id]); assert.equal(providerInputs[0].images, 1);
  assert.equal(actions.some(action => ['aiTranscribe', 'aiRealtimeStart'].includes(action)), false);
  assert.equal(await framePage.evaluate(() => microphoneRequests), 0);
  if (screenshots) for (const [width, height] of [[1180, 820], [820, 1180]]) {
    await framePage.setViewportSize({ width, height });
    assert.equal(await framePage.locator('.ai-dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await framePage.screenshot({ path: path.join(screenshots, `presence-question-${width}.png`) });
  }
  await framePage.locator('#aiQuestion').fill('这是以前旅行时拍的。'); await framePage.locator('#aiSend').click();
  await framePage.waitForFunction(() => document.querySelector('#aiMessages')?.textContent.includes('谢谢您分享'));
  assert.deepEqual(providerInputs[1].history.map(item => item.role), ['user', 'assistant']);
  assert.equal(providerInputs[1].history[1].content, '这张照片让您想起了什么？');
  await framePage.locator('#aiClose').click();
  providerFails = true;
  await api('presenceReport', makeEvent(), token); await framePage.locator('#presenceAccept').waitFor({ state: 'visible', timeout: 7000 });
  await framePage.locator('#presenceAccept').click();
  await framePage.waitForFunction(() => document.querySelector('#aiStatus')?.textContent.includes('已保留普通对话'));
  assert.equal(await framePage.locator('#aiReadPhoto').isChecked(), false);
  assert.equal(await framePage.locator('#aiQuestion').isEnabled(), true);
  assert.equal(providerInputs.length, 3);
  await framePage.locator('#aiClose').click();
  await api('presenceReport', makeEvent(), token); await framePage.locator('#presenceInvitation').waitFor({ state: 'visible', timeout: 7000 });
  await api('presenceSensorRevoke', { deviceId: 'living-room-link2' }, owner.token);
  await framePage.evaluate(() => poll()); assert.equal(await framePage.locator('#presenceInvitation').count(), 0);
  assert.deepEqual(errors, []);
  t.diagnostic(`Chrome ${await browser.version()}, real production Node HTTP + isolated LocalStore + synthetic uploaded photo + AI provider double; no API replacement, real model, cloud, hardware, microphone or GPU claim.`);
});
