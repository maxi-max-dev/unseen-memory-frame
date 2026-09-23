'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server/server');
const { LocalStore } = require('../server/store');
const { createNetwork, parseCamera } = require('../server/spatial-network');
const { SHARE: X5_SHARE, SCENE: X5_SCENE, zip, page: providerPage } = require('./helpers/spatial-fixture');

test('real HTTP + Chrome: family share text, automatic import, retry, shared viewing and revoked reads', {
  skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME, timeout: 180000
}, async t => {
  const realProvider = process.env.SPATIAL_REAL_SHARE === '1';
  assert.ok(!process.env.SPATIAL_REAL_SCENE || ['x5', 'x6'].includes(process.env.SPATIAL_REAL_SCENE), 'Only the two user-authorized real scenes');
  const SCENE = realProvider && process.env.SPATIAL_REAL_SCENE === 'x6' ? 'GS3DCfcc01814d19bae52c5ca65c7d75273bb' : X5_SCENE;
  const SHARE = SCENE === X5_SCENE ? X5_SHARE : 'https://app.insta360.com/3dspace/detail/' + SCENE;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spatial-browser-'));
  const model = zip(); let reads = 0, cameraCheck;
  const upstream = realProvider ? createNetwork() : {
    page: async () => providerPage(),
    download: async (_url, filename) => {
      await fs.writeFile(filename, model, { flag: 'wx' });
      return { bytes: model.length, digest: crypto.createHash('sha256').update(model).digest('hex') };
    }
  };
  const network = { ...upstream, ...(upstream.camera ? { camera: async (...args) => {
    const body = await upstream.camera(...args), cameras = JSON.parse(body);
    const previous = [...cameras.filter(c => /_cam1_up$/.test(c?.img_name)), ...cameras.filter(c => /_cam1_center$/.test(c?.img_name)), ...cameras]
      .map(camera => parseCamera(JSON.stringify([camera]))).find(Boolean);
    const selected = parseCamera(body);
    const pitch = view => view ? Math.round(Math.asin(Math.min(1, Math.abs(view.forward[1]))) * 180 / Math.PI * 100) / 100 : null;
    cameraCheck = { previousAbsPitchDegrees: pitch(previous), selectedAbsPitchDegrees: pitch(selected), sameAsPrevious: JSON.stringify(previous) === JSON.stringify(selected) };
    return body;
  } } : {}), page: async (...args) => {
    if (++reads === 1) return providerPage(SCENE, { outputs: [{ type: 'model', fileFormat: 'sog', url: 'https://unverified.invalid/file.sog?Signature=fixture-secret' }] });
    return upstream.page(...args);
  } };
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'isolated-spatial-fixture', spatial: { network },
    conversation: { capabilities: () => ({ text: false, vision: false, asr: false }) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { chromium } = require(process.env.AI_UX_PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: process.env.AI_UX_CHROME, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('spatial-browser-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function api(action, data = {}, token, status = 200) {
    const response = await fetch(origin + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') }, body: JSON.stringify({ action, data }) });
    assert.equal(response.status, status, action); return response.json();
  }
  const owner = await api('register', { username: 'spatialowner', password: 'local-only-password', mode: 'create', setupCode: 'isolated-spatial-fixture', name: '空间验收家庭' });
  const familyInvite = await api('invite', { role: 'family' }, owner.token);
  const family = await api('register', { username: 'spatialfamily', password: 'local-only-password', mode: 'join', invite: familyInvite.invite, nickname: '测试家人' });
  const frameInvite = await api('invite', { role: 'frame' }, owner.token);
  const frame = await api('join', { invite: frameInvite.invite, nickname: '测试相框' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ family, frame }) => {
    localStorage.setItem('memory-session-family', JSON.stringify(family));
    localStorage.setItem('memory-session-frame', JSON.stringify(frame));
  }, { family, frame });
  const page = await context.newPage(), errors = [], ranges = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/spatial-media/')) ranges.push({ status: response.status(), range: response.headers()['content-range'], bytes: Number(response.headers()['content-length']) });
  });
  // Browser always stays on our app; supplier downloads happen server-side.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (!realProvider) await context.route('**/spatial-viewer.js?*', route => route.fulfill({ contentType: 'application/javascript', body:
    'export function openSpatialViewer({container}){container.textContent="查看器替身：未渲染模型";return {destroy(){container.replaceChildren()}}}' }));
  await page.goto(origin + '/family');
  await page.locator('#plus').click(); await page.locator('#spatialComposeTab').click();
  await page.locator('#draftLink').fill('https://example.com/video.mp4');
  assert.match(await page.locator('#spatialLinkHint').innerText(), /视频重建/);
  await page.locator('#draftLink').fill('来看看我家的时光舱：' + SHARE + '?source=PHONE。');
  assert.equal(await page.locator('#send').innerText(), '寄出并导入空间');
  assert.match(await page.locator('#spatialLinkHint').innerText(), /已从分享文字/);
  await page.locator('#draftText').fill('空间里的家庭记忆');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#currentSpatial')?.textContent.includes('尚未支持的资源域名'));
  assert.equal(reads, 1, 'send starts the import exactly once');
  const failed = (await api('state', {}, family.token)).messages[0];
  assert.equal(failed.link, SHARE); assert.equal(failed.spatial.errorCode, 'unsupported_asset_host');
  assert.equal(await page.locator('#currentSpatial a').getAttribute('href'), SHARE);
  assert.equal(failed.spatial.failureStage, 'resolving'); assert.equal(JSON.stringify(failed).includes('fixture-secret'), false);
  if (process.env.AI_UX_SCREENSHOTS) {
    await fs.mkdir(process.env.AI_UX_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.AI_UX_SCREENSHOTS, 'spatial-family-retry.png'), fullPage: true });
  }
  await page.locator('#currentSpatial [data-spatial-action="import"]').click();
  await page.locator('#currentSpatial [data-spatial-action="view"]').waitFor({ timeout: 120000 });
  assert.equal(reads, 2);
  const ready = (await api('state', {}, owner.token)).messages[0];
  assert.equal(ready.spatial.status, 'ready'); assert.equal(ready.spatial.errorCode, undefined);
  const storedModel = (await app.store.get('sp_' + owner.room)).entries[SCENE];
  assert.equal(storedModel.format, 'sog');
  if (realProvider) {
    assert.ok(storedModel.view, 'real supplied camera data remains valid');
    assert.ok(cameraCheck.selectedAbsPitchDegrees <= cameraCheck.previousAbsPitchDegrees);
    if (SCENE === X5_SCENE) assert.equal(cameraCheck.sameAsPrevious, true, 'preserve the existing X5 starting pose');
    else assert.ok(cameraCheck.selectedAbsPitchDegrees < 10, 'X6 starts near the horizon');
  }
  assert.equal(ranges.length, 0, 'import/state never triggers browser model downloads before opening');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#currentSpatial [data-spatial-action="view"]').click();
  if (realProvider) {
    await page.locator('.spatial-viewer[data-state="ready"]').waitFor({ timeout: 90000 });
    await page.getByRole('button', { name: '回到起点，复位视角', exact: true }).click();
    await page.locator('.spatial-viewer canvas').press('ArrowRight');
    assert.equal(ranges.length, Math.ceil(ready.spatial.bytes / 4194304));
    assert.ok(ranges.every(r => r.status === 206 && r.bytes <= 4194304 && /^bytes \d+-\d+\/\d+$/.test(r.range)));
  } else await page.getByText('查看器替身：未渲染模型').waitFor();
  if (process.env.AI_UX_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.AI_UX_SCREENSHOTS, 'spatial-family-view.png') });
  await page.locator('#closeSpatial').click();
  assert.equal(await page.locator('.spatial-viewer').count(), 0);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(origin + '/frame');
  await page.locator('#frameMenu summary').click();
  await page.locator('#currentSpatial [data-spatial-action="view"]').click();
  if (realProvider) {
    await page.locator('.spatial-viewer[data-state="ready"]').waitFor({ timeout: 90000 });
    assert.equal(ranges.length, 2 * Math.ceil(ready.spatial.bytes / 4194304), 'frame also uses complete bounded download');
  }
  else await page.getByText('查看器替身：未渲染模型').waitFor();
  assert.equal(await page.locator('[data-spatial-action="import"]').count(), 0);
  if (process.env.AI_UX_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.AI_UX_SCREENSHOTS, 'spatial-frame-view.png') });
  await page.locator('#closeSpatial').click();
  const asset = await api('spatialAsset', { id: ready._id }, frame.token);
  await api('logout', {}, frame.token);
  assert.equal((await fetch(origin + asset.url, { headers: { Range: 'bytes=0-0' } })).status, 404);
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({ realProvider, scene: SCENE === X5_SCENE ? 'x5' : 'x6', localStore: 'isolated', backend: 'real HTTP', viewer: realProvider ? 'real PlayCanvas + SwiftShader software rendering; no hardware GPU claim' : 'explicit test double; no rendering claim', bytes: ready.spatial.bytes, digest: ready.spatial.digest, model: storedModel.model, cameraValidated: !!storedModel.view, cameraCheck, familySegments: realProvider ? Math.ceil(ready.spatial.bytes / 4194304) : 0, cloudWrites: 0 }));
});
