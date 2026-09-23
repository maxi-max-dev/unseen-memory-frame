'use strict';
// Opt-in real browser UI checks. API responses and media are doubles; no account,
// business server, microphone, provider, existing browser profile or desktop used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

test('isolated browser: login, narrow chat, keyboard, realtime fallback and capability errors', { skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME }, async t => {
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true });
  t.after(() => browser.close());
  const root = path.resolve(__dirname, '../server/public');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const server = http.createServer(async (req, res) => {
    try {
      let name = new URL(req.url, 'http://localhost').pathname;
      if (['/family', '/frame'].includes(name)) name = '/index.html';
      const file = path.resolve(root, '.' + name);
      if (!file.startsWith(root + path.sep)) throw Error('outside static root');
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const screenshots = process.env.AI_UX_SCREENSHOTS;
  if (screenshots) await fs.mkdir(screenshots, { recursive: true });
  t.diagnostic(`Headless Chrome ${await browser.version()}; static files with API/media doubles`);

  for (const width of [320, 390, 1280]) await t.test(`${width}px login and chat / realtime navigation`, async () => {
    const context = await browser.newContext({ viewport: { width, height: width === 1280 ? 900 : 780 } });
    try {
      const page = await context.newPage(), errors = [], actions = [], forbidden = [];
      let capabilitiesFail = false, realtimeMode = 'disabled';
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        globalThis.testMicrophoneAttempts = 0;
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
          globalThis.testMicrophoneAttempts++;
          throw new DOMException('Test blocks real microphone', 'NotAllowedError');
        } });
      });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || url.pathname.includes('/vendor/trtc')) { forbidden.push(url.pathname); return route.abort(); }
        if (url.pathname !== '/api') return route.continue();
        const { action, data } = route.request().postDataJSON(); actions.push({ action, data });
        const responses = {
          login: { token: 'ui-fixture-only', room: 'ui-fixture', role: 'owner', name: '测试家人', username: 'fixture01' },
          state: { room: { name: '界面验收家庭' }, members: [], people: [], receipts: [], messages: [], serverTime: Date.now(), messagePage: { total: 0, hasMore: false, nextCursor: null } },
          contactState: { members: [], requests: [] },
          framePresence: { ok: true },
          aiCapabilities: { text: true, vision: true, asr: true },
          aiRealtimeCapabilities: { enabled: realtimeMode !== 'disabled', provider: realtimeMode === 'unknown' ? 'unknown' : 'tencent-trtc', reason: 'TRTC secret configuration missing (fixture)' },
          aiChat: { answer: '本地替身回复：' + (data.text || ''), imageUsed: false, action: null },
          logout: { ok: true }
        };
        if (!Object.hasOwn(responses, action)) { forbidden.push(action); return route.fulfill({ status: 403, json: { error: 'Blocked by UI test' } }); }
        if ((action === 'aiCapabilities' && capabilitiesFail) || (action === 'aiRealtimeCapabilities' && realtimeMode === 'error')) return route.fulfill({ status: 503, json: { error: 'private configuration details' } });
        return route.fulfill({ json: responses[action] });
      });
      const visible = selector => page.locator(selector).waitFor({ state: 'visible' });
      const checkNoOverflow = async selector => {
        const box = await page.locator(selector).evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        assert.ok(box.scroll <= box.client + 1, `${selector} overflow at ${width}px: ${JSON.stringify(box)}`);
      };
      await page.goto(origin + '/family'); await visible('#authForm');
      assert.equal(await page.locator('#aiHomeEntry').count(), 0);
      await page.locator('[name=username]').fill('fixture01'); await page.locator('[name=password]').fill('local-ui-only');
      await page.locator('#authForm button[type=submit]').click(); await visible('#aiHomeChat');
      await page.waitForFunction(() => document.querySelector('#roomName')?.textContent === '界面验收家庭');
      assert.deepEqual(await page.locator('.family-tabbar button').evaluateAll(els => els.map(el => el.id)), ['homeTab', 'plus', 'mineTab']);
      await checkNoOverflow('body'); await checkNoOverflow('#aiHomeEntry');
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `home-${width}.png`), fullPage: true });
      await page.locator('#aiHomeChat').click(); await visible('#aiQuestion');
      await page.waitForFunction(() => !document.querySelector('#aiSend').disabled);
      assert.equal(await page.locator('#aiQuestion').evaluate(el => document.activeElement === el), true);
      await page.locator('#aiQuestion').fill('第一行'); await page.keyboard.press('Enter'); await page.keyboard.type('第二行');
      assert.equal(actions.filter(a => a.action === 'aiChat').length, 0);
      await page.keyboard.press('Control+Enter'); await page.waitForFunction(() => document.querySelector('#aiMessages').textContent.includes('本地替身回复'));
      assert.equal(actions.filter(a => a.action === 'aiChat').length, 1);
      assert.equal(await page.locator('#aiQuestion').evaluate(el => document.activeElement === el), true);
      await page.locator('#aiQuestion').fill('还没发送的文字');
      await checkNoOverflow('.ai-dialog');
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `text-${width}.png`) });
      await page.locator('#aiRealtimeEntry').click(); await visible('#realtimeText');
      await page.waitForFunction(() => document.querySelector('#realtimeAvailability').textContent.includes('尚未开通'));
      assert.equal(await page.locator('#realtimeStart').isDisabled(), true);
      assert.doesNotMatch(await page.locator('.ai-realtime-dialog').textContent(), /TRTC|secret|配置|权限与额度/);
      await checkNoOverflow('.ai-realtime-dialog');
      // Native modal tabbing keeps page navigation inert, including at narrow sizes.
      for (let n = 0; n < 8; n++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest('.ai-realtime-dialog')), true); }
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `realtime-${width}.png`) });
      await page.locator('#realtimeText').click(); await visible('#aiQuestion');
      assert.equal(await page.locator('#aiQuestion').inputValue(), '还没发送的文字');
      assert.match(await page.locator('#aiMessages').textContent(), /第一行/);
      await page.locator('#aiRealtimeEntry').click(); await page.keyboard.press('Escape'); await visible('#aiQuestion');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#aiHomeChat').evaluate(el => document.activeElement === el), true);
      await page.locator('#aiHomeLive').click(); await visible('#realtimeText'); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#aiHomeLive').evaluate(el => document.activeElement === el), true);
      capabilitiesFail = true; await page.locator('#openAI').click(); await visible('#aiRetry');
      await page.locator('#aiQuestion').fill('网络失败时的草稿');
      assert.equal(await page.locator('#aiSend').isDisabled(), true);
      capabilitiesFail = false; await page.locator('#aiRetry').click(); await page.waitForFunction(() => !document.querySelector('#aiSend').disabled);
      assert.equal(await page.locator('#aiQuestion').inputValue(), '网络失败时的草稿'); await page.keyboard.press('Escape');
      for (const mode of ['error', 'unknown']) {
        realtimeMode = mode; await page.locator('#aiHomeLive').click();
        await page.waitForFunction(() => !document.querySelector('#realtimeAvailability').textContent.includes('正在检查'));
        assert.equal(await page.locator('#realtimeStart').isDisabled(), true); await page.keyboard.press('Escape');
      }
      // Only a rejected media double runs; no SDK/start request is allowed.
      realtimeMode = 'enabled'; await page.locator('#aiHomeLive').click();
      await page.waitForFunction(() => !document.querySelector('#realtimeStart').disabled);
      await page.locator('#realtimeStart').click();
      await page.waitForFunction(() => document.querySelector('#realtimeStatus').textContent.includes('未获得麦克风权限'));
      assert.equal(await page.evaluate(() => globalThis.testMicrophoneAttempts), 1);
      assert.equal(await page.locator('#realtimeStart').isDisabled(), false);
      assert.equal(await page.locator('#realtimeEnd').isDisabled(), true);
      await page.keyboard.press('Escape');
      await context.addInitScript(() => localStorage.setItem('memory-session-frame', JSON.stringify({ token: 'ui-frame-fixture-only', room: 'ui-fixture', role: 'frame' })));
      await page.goto(origin + '/frame'); await visible('#aiHomeChat');
      await page.locator('#aiHomeChat').click(); await visible('#aiQuestion');
      await page.keyboard.press('Escape');
      realtimeMode = 'disabled'; await page.locator('#aiHomeLive').click(); await visible('#realtimeText');
      await page.waitForFunction(() => document.querySelector('#realtimeAvailability').textContent.includes('尚未开通'));
      assert.equal(await page.locator('#realtimeStart').isDisabled(), true);
      assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
