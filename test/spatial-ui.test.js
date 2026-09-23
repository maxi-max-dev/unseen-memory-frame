'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server/public/app.js'),'utf8');
const spatialSource=source.slice(source.indexOf('// Spatial status'),source.indexOf('function receiptLabel'))
  .replace(/import\('\/spatial-viewer\.js(?:\?v=[^']+)?'\)/,'loadViewer()');
const link='https://app.insta360.com/3dspace/detail/GS3DC00000000000000000000000000000000';
function fixture(overrides={}){
  const nodes=new Map(),timers=new Map(),events=new Map();let serial=0,polls=0;
  function element(){return {dataset:{},children:[],open:false,hidden:false,textContent:'',listeners:{},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items},setAttribute(){},focus(){},contains(){return false},querySelector(){return null},addEventListener(name,fn){this.listeners[name]=fn},showModal(){this.open=true},close(){this.open=false;queueMicrotask(()=>this.listeners.close?.())}}}
  const $=selector=>{if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector)};
  const context=vm.createContext({console,URL,DOMException,AbortController,queueMicrotask,
    $,esc:value=>String(value??''),safeLink:value=>{try{return new URL(value).protocol==='https:'?value:'#'}catch{return '#'}},
    MemorySpatialLink:require('../server/public/spatial-link'),sending:false,
    frame:false,session:{token:'test'},sessionExpired:false,state:{messages:[{_id:'message',link}]},draft:{},
    document:{querySelectorAll:()=>[],createElement:element,addEventListener:(name,fn)=>events.set(name,fn)},window:{addEventListener(){}},
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),
    toast(){},poll(){polls++},api:async()=>({}),loadViewer:async()=>({openSpatialViewer:()=>({destroy(){}})}),...overrides});
  vm.runInContext(spatialSource,context);
  return {context,$,timers,run:code=>vm.runInContext(code,context),polls:()=>polls};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('only the exact supported HTTPS share shape offers import',()=>{
  const f=fixture();assert.equal(f.run(`eligibleSpatialLink(${JSON.stringify(link)})`),true);
  for(const bad of [link.replace('https:','http:'),link.replace('app.insta360.com','app.insta360.com.evil.test'),link.replace('app.insta360.com','name@app.insta360.com'),link+'/extra',link.replace('GS3DC','GS3D'),link+'#x',' '+link,link.replace('https://','https:\\\\')])assert.equal(f.context.eligibleSpatialLink(bad),false,bad);
});

test('composer distinguishes share text, video and model files and labels the real send action',()=>{
  const f=fixture();
  f.context.draft.link='看看我们的时光舱 '+link+'?source=PHONE';f.context.refreshLinkHint();
  assert.match(f.$('#spatialLinkHint').textContent,/已从分享文字/);assert.equal(f.$('#send').textContent,'寄出并导入空间');
  f.context.draft.link='https://example.com/video.mp4';f.context.refreshLinkHint();
  assert.match(f.$('#spatialLinkHint').textContent,/视频重建/);assert.equal(f.$('#send').textContent,'寄出来源链接');
  assert.match(f.context.spatialPanel({_id:'file',link:'https://example.com/file.sog'}),/模型文件地址/);
  assert.match(f.context.spatialPanel({_id:'failed',link,spatial:{status:'failed',failureStage:'resolving',error:'测试失败'}}),/正在读取分享页面时未完成/);
});
test('a queued result remains queued; a duplicate UI click does not start another request',async()=>{
  let finish,calls=0;const f=fixture({api:()=>{calls++;return new Promise(resolve=>{finish=resolve})}});
  const request=f.context.importSpatial('message');await f.context.importSpatial('message');assert.equal(calls,1);
  finish({spatial:{status:'queued',updatedAt:1}});await request;
  assert.equal(f.context.state.messages[0].spatial.status,'queued');assert.equal(f.run('spatialRequests.size'),0);assert.equal(f.timers.size,0);
});
test('a half-open request times out, releases retry lock and polls without declaring failure',async()=>{
  const f=fixture({api:(_action,_data,_token,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))});
  const request=f.context.importSpatial('message');const timer=[...f.timers.values()][0];assert.equal(timer.ms,160000);timer.fn();await request;
  assert.equal(f.run('spatialRequests.size'),0);assert.equal(f.context.state.messages[0].spatial,undefined);assert.match(f.run("spatialRequestErrors.get('message')"),/超时/);assert.equal(f.polls(),1);
});
test('session expiry cancels imports silently',async()=>{
  const f=fixture({api:(_action,_data,_token,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))});
  const request=f.context.importSpatial('message');f.context.sessionExpired=true;f.context.releaseSpatialSession();await request;
  assert.equal(f.run('spatialRequests.size'),0);assert.equal(f.run('spatialRequestErrors.size'),0);assert.equal(f.polls(),0);
});
test('closing while the asset is pending prevents later viewer construction',async()=>{
  let finish,mounts=0;const f=fixture({api:()=>new Promise(resolve=>{finish=resolve}),loadViewer:async()=>({openSpatialViewer:()=>{mounts++;return {destroy(){}}}})});
  f.context.state.messages[0].spatial={status:'ready'};
  const opening=f.context.showSpatialViewer('message');f.context.closeSpatialViewer();finish({format:'sog'});await opening;
  assert.equal(mounts,0);assert.equal(f.$('#spatialDialog').open,false);
});
test('reopening survives the old dialog close event and destroys the old instance once',async()=>{
  let mounts=0,destroys=0;const f=fixture({api:async()=>({format:'sog'}),loadViewer:async()=>({openSpatialViewer:()=>{mounts++;return {destroy(){destroys++}}}})});
  f.context.state.messages[0].spatial={status:'ready'};
  await f.context.showSpatialViewer('message');await f.context.showSpatialViewer('message');await settle();
  assert.equal(mounts,2);assert.equal(destroys,1);assert.equal(f.$('#spatialDialog').open,true);
  f.context.closeSpatialViewer();await settle();assert.equal(destroys,2);
});
test('state-panel refresh never constructs viewers or requests assets',()=>{
  let calls=0;const f=fixture({api:()=>{calls++}});f.context.state.messages[0].spatial={status:'ready'};
  for(let i=0;i<5;i++)f.context.refreshSpatialPanels();assert.equal(calls,0);assert.equal(f.run('spatialView'),null);
});

test('a spatial dialog reports readiness only after the renderer succeeds, then clears it on error',async()=>{
  let mount;const reports=[];
  const f=fixture({reportFramePresence:()=>reports.push(f.run('spatialView?.ready||false')),api:async()=>({format:'sog'}),loadViewer:async()=>({openSpatialViewer:({container})=>{mount=container;return {destroy(){}}}})});
  f.context.state.messages[0].spatial={status:'ready'};
  await f.context.showSpatialViewer('message');
  assert.equal(f.run('spatialView.ready'),false);assert.deepEqual(reports,[false]);
  mount.listeners['spatial-viewer-state']({detail:{state:'ready'}});
  assert.equal(f.run('spatialView.ready'),true);assert.deepEqual(reports,[false,true]);
  mount.listeners['spatial-viewer-state']({detail:{state:'error'}});
  assert.equal(f.run('spatialView.ready'),false);assert.deepEqual(reports,[false,true,false]);
});

test('late renderer events cannot mark a replacement or closed spatial viewer as ready',async()=>{
  const mounts=[];let reports=0;
  const f=fixture({reportFramePresence:()=>reports++,api:async()=>({format:'sog'}),loadViewer:async()=>({openSpatialViewer:({container})=>{mounts.push(container);return {destroy(){}}}})});
  f.context.state.messages[0].spatial={status:'ready'};
  await f.context.showSpatialViewer('message');await f.context.showSpatialViewer('message');
  const before=reports;mounts[0].listeners['spatial-viewer-state']({detail:{state:'ready'}});
  assert.equal(f.run('spatialView.ready'),false);assert.equal(reports,before);
  f.context.closeSpatialViewer();const closed=reports;
  mounts[1].listeners['spatial-viewer-state']({detail:{state:'ready'}});
  assert.equal(f.run('spatialView'),null);assert.equal(reports,closed);
});
