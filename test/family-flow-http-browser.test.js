'use strict';
// Actual app + HTTP + fresh LocalStore; Chrome synthetic capture and explicit
// provider doubles. Never reads an existing family, deployment file or profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');

test('family flow: real registration, invitations, send, frame reply and management', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME,
  timeout: 180000
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unseen-family-flow-'));
  const aiInputs = [], errors = [], external = [], actions = [];
  let browser;
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'isolated-flow-fixture',
    ai: {
      transcribe: async () => '测试替身转写：记得那次一起散步。',
      summarize: async () => ({ title: '本地替身整理', summary: '测试音频的整理结果。', people: [], year: '', place: '', source: 'ai', confirmed: false })
    },
    conversation: {
      capabilities: () => ({ text: true, vision: true, asr: true }),
      complete: async input => { aiInputs.push(input); return { answer: '测试替身回答：可以和我聊聊今天。', action: null }; },
      transcribe: async () => '测试替身语音输入'
    },
    realtime: { provider: { capabilities: () => ({ enabled: false, provider: 'tencent-trtc', reason: 'Local test explicitly disabled' }) } }
  });
  t.after(async () => {
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('unseen-family-flow-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  async function pageFor(width, height) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(() => {
      globalThis.flowCaptureAttempts = 0;
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => { globalThis.flowCaptureAttempts++; return capture(...args); };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
      return route.continue();
    });
    page.on('request', request => {
      if (request.url() === origin + '/api' && request.method() === 'POST') actions.push(request.postDataJSON().action);
    });
    return page;
  }
  const owner = await pageFor(390, 844), family = await pageFor(390, 844), frame = await pageFor(1180, 820);
  const visible = (page, selector) => page.locator(selector).waitFor({ state: 'visible' });
  const screenshot = async (page, name) => {
    if (!process.env.AI_UX_SCREENSHOTS) return;
    await fs.mkdir(process.env.AI_UX_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.AI_UX_SCREENSHOTS, name + '.png'), fullPage: true });
  };
  async function http(action, data, token, expected = 200) {
    const response = await fetch(origin + '/api', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + token
    }, body: JSON.stringify({ action, data }) });
    assert.equal(response.status, expected, action);
    return response.json();
  }
  const getSession = page => page.evaluate(() => JSON.parse(localStorage.getItem(location.pathname === '/frame' ? 'memory-session-frame' : 'memory-session-family')));
  async function login(page, username, password) {
    await page.locator('[name=username]').fill(username);
    await page.locator('[name=password]').fill(password);
    await page.locator('#authForm button[type=submit]').click();
  }
  async function invite(kind) {
    await owner.locator('#mineTab').click(); await owner.locator('#invite').click();
    await owner.locator(kind === 'frame' ? '#frameInvite' : '#familyInvite').click();
    await visible(owner, '.invite-link');
    const link = await owner.locator('.invite-link').innerText();
    await owner.locator('#closeModal').click();
    return link;
  }
  async function record(page) {
    await page.locator('#record').click(); await visible(page, '#stopRecord');
    await page.waitForFunction(() => recording?.samples >= recording?.context.sampleRate);
    await page.locator('#stopRecord').click();
    await page.waitForFunction(() => document.querySelector('#recorder')?.textContent.includes('原声已录好'));
  }
  let ownerSession, familySession, frameSession, photoId, sensorToken;
  await t.test('create account, wrong password, login and navigation order', async () => {
    await owner.goto(origin + '/family'); await owner.locator('#registerTab').click();
    await owner.locator('[name=username]').fill('flow-owner');
    await owner.locator('[name=password]').fill('test-only-password');
    await owner.locator('[name=nickname]').fill('测试创建者');
    await owner.locator('[name=mode][value=create]').check();
    await owner.locator('[name=name]').fill('本地流程测试家庭');
    await owner.locator('[name=setupCode]').fill('isolated-flow-fixture');
    await owner.locator('#authForm button[type=submit]').click(); await visible(owner, '#mineTab');
    await owner.waitForFunction(() => document.querySelector('#roomName')?.textContent === '本地流程测试家庭');
    assert.deepEqual(await owner.locator('.family-tabbar button').evaluateAll(items => items.map(item => item.id)), ['homeTab', 'plus', 'mineTab']);
    ownerSession = await getSession(owner);
    assert.equal(ownerSession.role, 'owner');
    assert.equal(Object.hasOwn(ownerSession, 'password'), false);
    await owner.locator('#settings').click(); await owner.locator('#logout').click(); await visible(owner, '#authForm');
    await http('state', {}, ownerSession.token, 401);
    await login(owner, 'flow-owner', 'wrong-test-password'); await visible(owner, '#authError');
    assert.match(await owner.locator('#authError').innerText(), /账号|密码/);
    await login(owner, 'flow-owner', 'test-only-password'); await visible(owner, '#mineTab');
    ownerSession = await getSession(owner);
  });
  await t.test('invite family account and pair independent frame through UI', async () => {
    await family.goto(await invite('family'));
    await family.locator('[name=username]').fill('flow-family');
    await family.locator('[name=password]').fill('test-only-family-password');
    await family.locator('[name=nickname]').fill('测试家人');
    await family.locator('#authForm button[type=submit]').click(); await visible(family, '#mineTab');
    familySession = await getSession(family);
    assert.equal(familySession.role, 'family'); assert.equal(familySession.room, ownerSession.room);
    await frame.goto(await invite('frame'));
    await frame.locator('[name=nickname]').fill('测试客厅相框');
    await frame.locator('#authForm button[type=submit]').click(); await visible(frame, '#record');
    frameSession = await getSession(frame);
    assert.equal(frameSession.role, 'frame'); assert.equal(frameSession.room, ownerSession.room);
    assert.equal(new URL(frame.url()).hash, '');
    await family.locator('#settings').click();
    assert.equal(await family.locator('#presenceSettingsEntry').count(), 0);
    await family.locator('#closeModal').click();
  });
  await t.test('text-only send and persistent draft across refresh', async () => {
    await family.locator('#plus').click(); await family.locator('#draftText').fill('第一封测试家书');
    // Observe IndexedDB completion before explicitly closing the browser document.
    await family.waitForFunction(async () => {
      const tx = db.transaction('drafts');
      const value = await new Promise(resolve => { const r = tx.objectStore('drafts').get(draftKey()); r.onsuccess = () => resolve(r.result); });
      return value?.text === '第一封测试家书';
    });
    await family.reload(); await family.locator('#plus').click();
    assert.equal(await family.locator('#draftText').inputValue(), '第一封测试家书');
    await family.locator('#send').click();
    await frame.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('第一封测试家书'));
    assert.equal(await frame.locator('#listen').isDisabled(), true);
    const state = await http('state', {}, ownerSession.token);
    assert.equal(state.messages.filter(m => m.text === '第一封测试家书').length, 1);
  });
  await t.test('photo plus original synthetic audio upload, receive and playback receipt', async () => {
    const png = await family.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 600;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#d6ece7'; ctx.fillRect(0, 0, 900, 600);
      ctx.fillStyle = '#ffcd5c'; ctx.beginPath(); ctx.arc(690, 140, 75, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#537e65'; ctx.fillRect(0, 400, 900, 200);
      return c.toDataURL('image/png').split(',')[1];
    });
    await family.locator('#plus').click();
    await family.locator('#file').setInputFiles({ name: 'synthetic-test-landscape.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await visible(family, '#draftImage'); await family.locator('#draftText').fill('测试照片：一起散步');
    await record(family); await screenshot(family, 'family-compose-synthetic');
    await family.locator('#send').click();
    await frame.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('测试照片：一起散步'));
    await frame.waitForFunction(() => document.querySelector('#photo img')?.naturalWidth > 0);
    const state = await http('state', {}, ownerSession.token);
    const photo = state.messages.find(m => m.text === '测试照片：一起散步'); photoId = photo._id;
    assert.ok(photo.image && photo.audio && photo.duration >= 1);
    const bytes = Buffer.from(await (await fetch(origin + photo.audioURL)).arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.ok(bytes.length > 32000);
    await frame.locator('#listen').click();
    await frame.waitForFunction(() => state.receipts.some(r => r.message === selected && r.playedAt));
    assert.ok((await http('state', {}, ownerSession.token)).receipts.find(r => r.message === photoId)?.playedAt);
    if ((await frame.locator('#listen').innerText()).includes('暂停')) await frame.locator('#listen').click();
    await screenshot(frame, 'frame-photo-landscape');
  });
  await t.test('frame records reply; family receives and edits it', async () => {
    await record(frame); await frame.locator('#sendRecording').click();
    await family.waitForFunction(() => state?.messages.some(m => m.type === 'reply'));
    const state = await http('state', {}, ownerSession.token);
    const reply = state.messages.find(m => m.type === 'reply');
    assert.ok(reply?.audio); assert.equal(reply.parent, photoId);
    await family.locator(`[data-memory="${reply._id}"]`).first().click();
    await visible(family, '#editForm');
    await family.locator('#editForm [name=title]').fill('一起散步的回忆');
    await family.locator('#editForm [name=text]').fill('家人手工修订的故事。');
    await family.locator('#editForm [name=summary]').fill('大家一起散步。');
    const saved = family.waitForResponse(response => response.url() === origin + '/api' && response.request().postDataJSON()?.action === 'edit' && response.status() === 200);
    await family.locator('#editForm button[type=submit], #editForm button.primary').click();
    await saved;
    await family.locator('#modal').waitFor({ state: 'hidden' });
    const updated = (await http('state', {}, ownerSession.token)).messages.find(m => m._id === reply._id);
    assert.equal(updated.editedText, '家人手工修订的故事。'); assert.equal(updated.card.confirmed, true);
    await screenshot(family, 'family-home-reply');
  });
  await t.test('owner sensor binding, rotate and revoke; family forbidden', async () => {
    await owner.locator('#settings').click(); await owner.locator('#presenceSettingsEntry').click();
    await owner.locator('#sensorFrame option', { hasText: '测试客厅相框' }).waitFor({ state: 'attached' });
    await owner.locator('#sensorIssue').click(); await visible(owner, '#presenceSensorToken');
    sensorToken = await owner.locator('#presenceSensorToken').inputValue();
    assert.ok(sensorToken); assert.equal(await owner.locator('#presenceSensorToken').getAttribute('type'), 'password');
    await owner.locator('#sensorClear').click();
    assert.equal(await owner.locator('#presenceSensorToken').count(), 0);
    const sensors = await http('presenceSensorList', {}, ownerSession.token);
    assert.equal(sensors.sensors[0].active, true);
    assert.equal(sensors.frames.find(f => f.id === sensors.sensors[0].targetFrameId).name, '测试客厅相框');
    await http('presenceSensorList', {}, familySession.token, 403);
    owner.once('dialog', dialog => dialog.accept());
    await owner.locator('[data-sensor-rotate]').click(); await visible(owner, '#presenceSensorToken');
    assert.notEqual(await owner.locator('#presenceSensorToken').inputValue(), sensorToken);
    await owner.locator('#sensorClear').click();
    owner.once('dialog', dialog => dialog.accept()); await owner.locator('[data-sensor-revoke]').click();
    await owner.waitForFunction(() => document.querySelector('#sensorList')?.textContent.includes('已停用'));
    await screenshot(owner, 'sensor-revoked'); await owner.locator('#sensorClose').click();
  });
  await t.test('ordinary AI and photo choice use real HTTP with explicit provider double; realtime disabled', async () => {
    await family.locator('#aiHomeChat').click(); await visible(family, '#aiQuestion');
    await family.locator('#aiQuestion').fill('今天过得怎么样？'); await family.locator('#aiSend').click();
    await family.waitForFunction(() => document.querySelector('#aiMessages')?.textContent.includes('测试替身回答'));
    assert.equal(aiInputs.at(-1).images.length, 0);
    await family.locator('#aiPhotoPicker summary').click(); await family.locator('#aiMemory').selectOption(photoId);
    await family.locator('#aiAddPhoto').click(); await family.locator('#aiReadPhoto').check();
    await family.locator('#aiQuestion').fill('一起看看这张照片'); await family.locator('#aiSend').click();
    await family.waitForFunction(() => !document.querySelector('#aiSend')?.disabled);
    assert.equal(aiInputs.at(-1).images.length, 1); assert.equal(aiInputs.at(-1).history.length, 2);
    await family.locator('#aiQuestion').fill('还没有发送的聊天草稿');
    const captures = await family.evaluate(() => globalThis.flowCaptureAttempts);
    await family.locator('#aiRealtimeEntry').click();
    await family.waitForFunction(() => document.querySelector('#realtimeAvailability')?.textContent.includes('尚未开通'));
    assert.equal(await family.locator('#realtimeStart').isDisabled(), true);
    assert.equal(await family.evaluate(() => globalThis.flowCaptureAttempts), captures);
    assert.equal(actions.includes('aiRealtimeStart'), false);
    await screenshot(family, 'realtime-disabled'); await family.locator('#realtimeText').click();
    assert.equal(await family.locator('#aiQuestion').inputValue(), '还没有发送的聊天草稿');
    await family.locator('#aiClose').click();
  });
  await t.test('frame portrait controls and family logout/relogin keep family content', async () => {
    await frame.setViewportSize({ width: 820, height: 1180 });
    for (const id of ['listen', 'record']) {
      const box = await frame.locator('#' + id).boundingBox();
      assert.ok(box && box.width >= 80 && box.height >= 80 && box.y >= 0 && box.y + box.height <= 1180);
    }
    await screenshot(frame, 'frame-photo-portrait');
    await family.locator('#settings').click(); await family.locator('#logout').click(); await visible(family, '#authForm');
    await http('state', {}, familySession.token, 401);
    await login(family, 'flow-family', 'test-only-family-password'); await visible(family, '#mineTab');
    familySession = await getSession(family);
    assert.equal(familySession.room, ownerSession.room);
    assert.equal((await http('state', {}, familySession.token)).messages.length, 3);
  });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  t.diagnostic(`Chrome ${await browser.version()}; new temp LocalStore; actual business HTTP and UI. Synthetic Chrome microphone and AI/ASR/summarization doubles only. No cloud, hardware, human audio, mobile Safari or GPU evidence.`);
});
