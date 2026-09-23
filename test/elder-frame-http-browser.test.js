'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');

test('real local HTTP: family preview remains read-only and tablet frame reports its own presence', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elder-frame-http-'));
  // This store is explicitly isolated, even when the launching shell has cloud settings.
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'local-browser-fixture',
    conversation: { capabilities: () => ({ text: false, vision: false, asr: false }) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    // mkdtemp produced this exact target under os.tmpdir; never remove a supplied path.
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('elder-frame-http-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function api(action, data, token) {
    const response = await fetch(origin + '/api', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '')
    }, body: JSON.stringify({ action, data }) });
    assert.equal(response.status, 200, action);
    return response.json();
  }
  const owner = await api('create', { setupCode: 'local-browser-fixture', name: '本地相框验收' });
  const invite = await api('invite', { role: 'frame' }, owner.token);
  const frame = await api('join', { invite: invite.invite, nickname: '本地平板' });
  for (const [id, text] of [['first', '第一封家书'], ['second', '第二封家书']]) {
    await api('send', { id, text }, owner.token);
  }
  const before = await api('state', {}, owner.token);
  assert.equal(before.framePresence.online, false);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ owner, frame }) => {
    localStorage.setItem('memory-session-family', JSON.stringify(owner));
    localStorage.setItem('memory-session-frame', JSON.stringify(frame));
  }, { owner, frame });
  const page = await context.newPage(), actions = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api' && request.method() === 'POST') actions.push(request.postDataJSON().action);
  });
  await page.goto(origin + '/family');
  await page.locator('#openFramePreview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('第二封家书'));
  const selection = await page.locator('#caption').innerText();
  const actionOffset = actions.length;
  await page.locator('#openFramePreview').click();
  await page.locator('#familyFramePreview').waitFor({ state: 'visible' });
  await page.locator('#previewPrev').click();
  await page.waitForFunction(() => document.querySelector('#previewCaption')?.textContent.includes('第一封家书'));
  await page.locator('#closeFramePreview').click();
  assert.equal(await page.locator('#familyFramePreview').count(), 0);
  assert.equal(await page.locator('#caption').innerText(), selection);
  assert.equal(actions.slice(actionOffset).some(action => ['framePresence', 'receipt', 'send', 'join', 'invite'].includes(action)), false);
  const after = await api('state', {}, owner.token);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(after.framePresence.online, false);
  assert.equal(after.messagePage.total, before.messagePage.total);

  await page.setViewportSize({ width: 1280, height: 800 });
  const presenceResponse = page.waitForResponse(response => response.url() === origin + '/api' && response.request().postDataJSON()?.action === 'framePresence' && response.status() === 200);
  await page.goto(origin + '/frame');
  await page.locator('#record').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#caption')?.textContent.includes('第二封家书'));
  await presenceResponse;
  const visibleFrame = await api('state', {}, owner.token);
  assert.equal(visibleFrame.framePresence.online, true);
  assert.equal(visibleFrame.framePresence.activity, 'viewing');
  assert.equal(await page.locator('#record').isEnabled(), true);
  assert.equal(await page.locator('#listen').isDisabled(), true, 'text-only memory does not pretend to have original audio');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }]) {
    await page.setViewportSize(viewport);
    for (const selector of ['#listen', '#record']) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.width >= 80 && bounds.height >= 80, `${selector} large tablet target`);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `${selector} initially visible at ${viewport.width}x${viewport.height}`);
    }
  }
  assert.deepEqual(errors, []);
  t.diagnostic('Real local Node HTTP, isolated LocalStore and headless Chrome; no microphone, supplier, cloud or GPU verification.');
});
