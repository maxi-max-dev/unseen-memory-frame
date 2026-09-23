'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../server/public/family-experience.js'),'utf8');
const presenceSource=source.slice(source.indexOf('function framePresenceRemaining'),source.indexOf('function applyLocalDisplay'));
function fixture(overrides={}){
  let clock=500,id=0;const timers=new Map(),nodes=new Map(),reports=[];
  const element=()=>({textContent:'',hidden:false,replaceChildren(){},append(){},after(){}});
  const $=selector=>{if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector)};
  const context=vm.createContext({$,console,AbortController,performance:{now:()=>clock},setTimeout:(fn,ms)=>{const next=++id;timers.set(next,{fn,ms});return next},clearTimeout:id=>timers.delete(id),
    frame:false,session:{token:'test'},sessionExpired:false,failures:0,presenceExpiryTimer:null,stateReceivedAt:500,presenceBusy:false,presenceQueued:false,presenceLast:'',presenceAt:0,followFrame:true,selected:'old',
    state:{serverTime:1800000000000,framePresence:{online:true,expiresAt:1800000045000,frameName:'相框',activity:'spatial',messageId:'new'},members:[{role:'frame'}],messages:[{_id:'new'}]},
    document:{hidden:false,documentElement:{classList:{contains:()=>false}},createElement:element},current:()=>({_id:'photo'}),recording:null,spatialView:null,frameAudio:null,
    api:async(action,data)=>reports.push({action,data:{...data}}),...overrides});
  vm.runInContext(presenceSource,context);
  return {context,$,timers,reports,setClock:value=>clock=value};
}

test('frame status expires locally without another state response and ignores wall clock skew',()=>{
  const f=fixture();f.context.renderFramePresence();assert.match(f.$('#framePresence').textContent,/正在看空间/);
  const timer=[...f.timers.values()][0];assert.equal(timer.ms,45001);
  f.setClock(45501);timer.fn();assert.match(f.$('#framePresence').textContent,/状态未同步/);assert.equal(f.timers.size,0);
  f.context.syncFrameSelection();assert.equal(f.context.selected,'old');
});

test('expired or disconnected presence never claims active viewing or follows a stale scene',()=>{
  const f=fixture();f.context.state.framePresence.expiresAt=f.context.state.serverTime;f.context.renderFramePresence();f.context.syncFrameSelection();
  assert.doesNotMatch(f.$('#framePresence').textContent,/正在看/);assert.equal(f.context.selected,'old');
  f.context.failures=1;f.context.renderFramePresence();assert.match(f.$('#framePresence').textContent,/连接中断/);assert.equal(f.timers.size,0);
});

test('frame activity distinguishes a loading or failed spatial dialog from a ready scene',async()=>{
  const f=fixture({frame:true,spatialView:{id:'scene',ready:false}});
  await f.context.reportFramePresence(true);assert.deepEqual(f.reports.at(-1).data,{activity:'idle',messageId:''});
  f.context.spatialView.ready=true;await f.context.reportFramePresence(true);assert.deepEqual(f.reports.at(-1).data,{activity:'spatial',messageId:'scene'});
  f.context.spatialView.ready=false;await f.context.reportFramePresence(true);assert.equal(f.reports.at(-1).data.activity,'idle');
  f.context.spatialView=null;await f.context.reportFramePresence(true);assert.deepEqual(f.reports.at(-1).data,{activity:'viewing',messageId:'photo'});
});

test('a hanging state request aborts and schedules recovery without keeping an active status',async()=>{
  const app=fs.readFileSync(path.join(__dirname,'../server/public/app.js'),'utf8');
  const polling=app.slice(app.indexOf('let stateRequest=null;'),app.indexOf('\nlet frameAudio;'));
  const f=fixture({authScreenActive:false,pollTimer:null,photos:()=>[],renderHistoryControls(){},api:(_action,_data,_token,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))),DOMException});
  vm.runInContext(polling,f.context);
  const pending=f.context.poll();const timeout=[...f.timers.values()].find(timer=>timer.ms===12000);assert.ok(timeout);timeout.fn();await pending;
  assert.equal(f.context.failures,1);assert.match(f.$('#framePresence').textContent,/状态待更新/);assert.match(f.$('#syncError').textContent,/同步等待超时/);
  assert.ok([...f.timers.values()].some(timer=>timer.ms===3000));
});
