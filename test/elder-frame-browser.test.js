'use strict';
// Opt-in real browser UI checks. API responses and media are doubles; no account,
// business server, microphone, provider, existing browser profile or desktop used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

test('elder tablet layout and isolated family preview', { skip: !process.env.AI_UX_PLAYWRIGHT || !process.env.AI_UX_CHROME }, async t => {
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

  const photo='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#b0d8df"/><circle cx="750" cy="150" r="75" fill="#fff0b5"/><path d="M0 600L300 200L650 650L850 380L1000 600V700H0" fill="#639b80"/></svg>');
  for(const [width,height,role] of [[1366,900,'frame'],[1180,820,'frame'],[1024,768,'frame'],[1280,800,'frame'],[820,1180,'frame'],[390,844,'owner'],[320,780,'owner']])await t.test(`${role} ${width}x${height}`,async()=>{
    const context=await browser.newContext({viewport:{width,height}});try{
      const page=await context.newPage(),actions=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
      const messages=[{_id:'m1',type:'photo',title:'周末去公园',text:'奶奶，今天的天空很好看。下次一起去散步吧。',imageURL:photo,name:'小雨',createdAt:1},{_id:'m2',type:'photo',title:'一封家书',text:'家里的话。'.repeat(150),name:'小雨',createdAt:2}];
      await page.addInitScript(({role})=>localStorage.setItem('memory-session-'+(role==='frame'?'frame':'family'),JSON.stringify({token:'fixture',room:'fixture',role,name:'家人'})),{role});
      await page.route('**/api',route=>{const {action}=route.request().postDataJSON();actions.push(action);const responses={state:{room:{name:'我们的家'},members:[],people:[],receipts:[],messages,serverTime:Date.now()},framePresence:{ok:true},receipt:{ok:true},contactState:{members:[],requests:[]},aiCapabilities:{text:true},aiRealtimeCapabilities:{enabled:false},logout:{ok:true}};return route.fulfill({json:responses[action]||{}})});
      await page.goto(origin+'/'+(role==='frame'?'frame':'family'));await page.waitForFunction(()=>document.querySelector('#caption')?.textContent.includes('一封家书'));
      const overflow=async selector=>assert.equal(await page.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,selector+' horizontal overflow');await overflow('body');
      if(role==='frame'){
        await page.locator('#prev').click();await page.waitForFunction(()=>document.querySelector('#photo img'));
        for(const id of ['listen','record']){const box=await page.locator('#'+id).boundingBox();assert.ok(box.width>=110&&box.height>=110);assert.ok(box.y+box.height<=height, id+' must be visible initially')}
        await page.locator('#listen').evaluate(el=>{el.textContent='Ⅱ 暂停原声'});await overflow('#listen');await page.locator('#listen').evaluate(el=>{el.textContent='▶ 听原声'});
        await page.locator('#frameMenu summary').click();await page.locator('#settings').click();await page.locator('#modal').waitFor({state:'visible'});await page.locator('#closeModal').click();
        if(screenshots)await page.screenshot({path:path.join(screenshots,`frame-${width}.png`),fullPage:true});
        await page.locator('#aiHomeLive').click();await page.waitForFunction(()=>document.querySelector('#realtimeStart')?.disabled);await overflow('.ai-realtime-dialog');await page.keyboard.press('Escape');
      }else{
        const initial=await page.locator('#caption').textContent();actions.length=0;
        await page.locator('#openFramePreview').click();await page.locator('#familyFramePreview').waitFor({state:'visible'});await overflow('#familyFramePreview');
        await page.locator('#previewPrev').click();assert.ok(await page.locator('#previewPhoto img').count());assert.equal(await page.locator('#caption').textContent(),initial);
        assert.equal(await page.locator('#familyFramePreview audio').count(),0);assert.deepEqual(actions.filter(a=>['receipt','framePresence','send','aiRealtimeStart'].includes(a)),[]);
        if(screenshots)await page.screenshot({path:path.join(screenshots,`preview-${width}.png`)});
        await page.evaluate(()=>{state.messages.find(m=>m._id===framePreviewId).imageURL='/refreshed-photo';refreshExperience()});assert.ok((await page.locator('#previewPhoto img').getAttribute('src')).includes('refreshed-photo'));
        await page.evaluate(()=>{state.messages=[];refreshExperience()});assert.match(await page.locator('#previewPhoto').textContent(),/还没有照片/);
        await page.keyboard.press('Escape');assert.equal(await page.locator('#familyFramePreview').count(),0);
        await page.locator('#openFramePreview').click();await page.evaluate(()=>expireSession('验收失效'));assert.equal(await page.locator('#familyFramePreview').count(),0);
        assert.deepEqual(await page.locator('.family-tabbar button').evaluateAll(els=>els.map(el=>el.id)),['homeTab','plus','mineTab']);
      }assert.deepEqual(errors,[]);
    }finally{await context.close()}
  });
});
