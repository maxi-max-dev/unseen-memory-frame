'use strict';
// Complements the success/fallback test with actual HTTP cancellation and busy
// gates. Only fresh test data; AI is a deferred provider double, never a vendor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');

test('family audit: real HTTP presence decline, busy drop, stop and late answer', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME, timeout: 90000
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-presence-controls-'));
  const calls = [], releases = [], errors = [], external = [];
  let browser;
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'presence-controls-fixture',
    conversation: {
      capabilities: () => ({ text: true, vision: true, asr: false }),
      complete: async (input, _app, { signal }) => {
        calls.push({ signal, images: input.images.length });
        return new Promise(resolve => releases.push(() => resolve({ answer: '这张照片让您想起了什么？', action: null })));
      }
    },
    realtime: { provider: { capabilities: () => ({ enabled: false, provider: 'tencent-trtc', reason: 'Disabled in local audit' }) } }
  });
  t.after(async () => {
    for (const release of releases) release();
    await browser?.close(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('family-presence-controls-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function api(action, data = {}, token) {
    const response = await fetch(origin + '/api', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '')
    }, body: JSON.stringify({ action, data }) });
    assert.equal(response.status, 200, action); return response.json();
  }
  const owner = await api('create', { setupCode: 'presence-controls-fixture', name: '驻足取消测试家庭' });
  const invite = await api('invite', { role: 'frame' }, owner.token);
  const frame = await api('join', { invite: invite.invite, nickname: '测试相框' });
  const list = await api('presenceSensorList', {}, owner.token);
  const sensor = await api('presenceSensorIssue', { deviceId: 'audit-link2', targetFrameId: list.frames[0].id }, owner.token);
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await context.addInitScript(session => {
    localStorage.setItem('memory-session-frame', JSON.stringify(session));
    globalThis.auditMicrophone = 0; globalThis.auditSpeech = 0;
    navigator.mediaDevices.getUserMedia = async () => { globalThis.auditMicrophone++; throw Error('No real microphone in audit'); };
    speechSynthesis.speak = () => { globalThis.auditSpeech++; };
  }, frame);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(new URL(route.request().url()).hostname); return route.abort();
  });
  await page.goto(origin + '/frame');
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 400;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#d6ece7'; ctx.fillRect(0, 0, 600, 400);
    return c.toDataURL('image/png').split(',')[1];
  });
  const media = await api('upload', { base64: image }, owner.token);
  await api('send', { id: 'controls-photo', image: media.id, text: '一张合成测试照片' }, owner.token);
  await page.waitForFunction(() => document.querySelector('#photo img')?.naturalWidth > 0);
  async function report() {
    const event = await api('presenceReport', { version: 1, eventId: randomUUID(), source: 'link2-windows',
      deviceId: 'audit-link2', type: 'presence.dwell', occurredAt: Date.now(), dwellMs: 4200, headCount: 1 }, sensor.token);
    await page.evaluate(() => poll());
    await page.waitForFunction(seq => JSON.parse(localStorage.getItem('memory-presence-seen-v1:' + session.room) || 'null')?.seq === seq, event.seq);
  }
  const shown = () => page.locator('#presenceInvitation').waitFor({ state: 'visible' });
  const noInvitation = async () => assert.equal(await page.locator('#presenceInvitation').count(), 0);
  async function observeConsumedAgain() {
    await page.evaluate(() => poll());
    // Another completed state read proves the consumed event is not queued.
    await page.waitForFunction(() => !stateRequest);
    await noInvitation();
  }
  await t.test('decline and Escape never request AI and never reopen on the same event', async () => {
    await report(); await shown(); await page.locator('#presenceDecline').click(); await noInvitation();
    await observeConsumedAgain();
    await report(); await shown(); await page.keyboard.press('Escape'); await observeConsumedAgain();
    assert.equal(calls.length, 0);
  });
  await t.test('settings and ordinary AI dialogs consume busy events without later invitations', async () => {
    await page.locator('#frameMenu summary').click(); await page.locator('#settings').click();
    await report(); await noInvitation(); await page.locator('#closeModal').click(); await observeConsumedAgain();
    await page.locator('#aiHomeChat').click(); await page.locator('#aiQuestion').waitFor({ state: 'visible' });
    await report(); await noInvitation(); await page.locator('#aiClose').click(); await observeConsumedAgain();
    assert.equal(calls.length, 0);
  });
  await t.test('stop during first question aborts actual HTTP and ignores the late provider answer', async () => {
    await report(); await shown(); await page.locator('#presenceAccept').click();
    await page.waitForFunction(() => document.querySelector('#aiStatus')?.textContent.includes('AI 正在看'));
    // Wait for the real HTTP request to enter the delayed provider before stopping.
    await assertEventually(() => calls.length === 1);
    assert.equal(calls[0].images, 1);
    const failed = page.waitForEvent('requestfailed', request => request.url() === origin + '/api' && request.postDataJSON()?.action === 'aiChat');
    await page.locator('#aiStop').click(); await failed;
    await assertEventually(() => calls[0].signal.aborted);
    releases[0]();
    await page.waitForFunction(() => document.querySelector('#aiQuestion') && !document.querySelector('#aiQuestion').disabled);
    assert.equal(await page.locator('#aiMessages').innerText(), '');
    await page.locator('#aiQuestion').fill('我可以继续自己打字');
    await page.locator('#aiClose').click(); await observeConsumedAgain();
  });
  await t.test('close during first question stays closed after late answer; ordinary entry stays manual', async () => {
    await report(); await shown(); await page.locator('#presenceAccept').click();
    await assertEventually(() => calls.length === 2);
    const failed = page.waitForEvent('requestfailed', request => request.url() === origin + '/api' && request.postDataJSON()?.action === 'aiChat');
    await page.locator('#aiClose').click(); await failed;
    await assertEventually(() => calls[1].signal.aborted); releases[1]();
    await observeConsumedAgain(); assert.equal(await page.locator('.ai-dialog').count(), 0);
    await page.locator('#aiHomeChat').click();
    await page.waitForFunction(() => document.querySelector('#aiQuestion') && !document.querySelector('#aiQuestion').disabled);
    assert.equal(calls.length, 2); assert.equal(await page.locator('#aiMessages').innerText(), '');
    assert.equal(await page.locator('#aiPhotos img').count(), 0);
    await page.locator('#aiClose').click();
  });
  await t.test('successful first question stays silent; actual user text matching the internal seed remains visible', async () => {
    await report(); await shown(); await page.locator('#presenceAccept').click();
    await assertEventually(() => calls.length === 3); releases[2]();
    await page.waitForFunction(() => document.querySelector('#aiMessages')?.textContent.includes('这张照片让您想起了什么？'));
    assert.deepEqual(await page.locator('#aiMessages p').allTextContents(), ['AI：这张照片让您想起了什么？']);
    assert.deepEqual(await page.evaluate(() => [auditMicrophone, auditSpeech]), [0, 0]);
    await page.locator('#aiQuestion').fill('请根据这张照片，先问我一个问题。');
    await page.locator('#aiSend').click(); await assertEventually(() => calls.length === 4); releases[3]();
    await page.waitForFunction(() => !document.querySelector('#aiQuestion')?.disabled);
    assert.deepEqual(await page.locator('#aiMessages p').allTextContents(), [
      'AI：这张照片让您想起了什么？', '你：请根据这张照片，先问我一个问题。', 'AI：这张照片让您想起了什么？'
    ]);
    await page.locator('#aiClose').click();
  });
  assert.deepEqual(await page.evaluate(() => [auditMicrophone, auditSpeech]), [0, 0]);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  t.diagnostic(`Chrome ${await browser.version()}; real local HTTP, isolated LocalStore, synthetic photo and delayed AI double. No automatic microphone or speech calls; no cloud/vendor/hardware checks.`);
});

async function assertEventually(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'expected provider state within 5 seconds');
}
