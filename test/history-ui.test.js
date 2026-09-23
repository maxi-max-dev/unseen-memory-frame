'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../server/public/app.js'),'utf8');
const family=fs.readFileSync(path.join(__dirname,'../server/public/family-experience.js'),'utf8');
const controls=app.slice(app.indexOf('let stateRequest=null;'),app.indexOf('\nlet frameAudio;'));
const views=family.slice(family.indexOf('function renderHistoryControls'),family.indexOf('function framePresenceRemaining'));
const memory=(id,extra={})=>({_id:id,createdAt:Number(id.slice(1)),type:'photo',name:'家人',text:id,...extra});
const response=(messages,{old=[],total=4,cursor='older',hasMore=true,legacy=false}={})=>({messages,historyMessages:old,...(!legacy?{messagePage:{total,nextCursor:cursor,hasMore}}:{}),room:{name:'我们的家'},members:[],people:[],receipts:[],serverTime:500});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Execute the real request, reconciliation, filter and notice controllers with
// small DOM doubles. These are behavior tests, not browser-click evidence.
function fixture(){
  let timerId=0;const timers=new Map(),nodes=new Map(),calls=[];
  const $=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{hidden:selector==='#newReplyNotice',textContent:'',innerHTML:'',value:'',checked:true,disabled:false,dataset:{},attributes:{},classes:new Set(),
      setAttribute(key,value){this.attributes[key]=value},querySelectorAll(){return []},append(){},focus(){}});
    const node=nodes.get(selector);node.classList={toggle:(name,value)=>value?node.classes.add(name):node.classes.delete(name)};return node;
  };
  const context=vm.createContext({$,AbortController,DOMException,console,performance:{now:()=>500},frame:false,
    session:{token:'first',room:'room'},sessionExpired:false,authScreenActive:false,state:null,selected:'m4',draft:{text:'saved draft'},recording:null,frameAudio:null,pollTimer:null,failures:0,stateReceivedAt:0,
    seenReplies:null,followFrame:false,experienceSignature:'',listSignature:'',treePerson:'',treeYear:'',treeMode:'people',
    document:{hidden:false,activeElement:null,querySelectorAll:()=>[],createElement:()=>({})},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId},clearTimeout:id=>timers.delete(id),
    esc:value=>String(value??''),memoryYear:message=>Number(message.card?.year)||null,memoryButton:message=>`<b>${message._id}:${message.text}</b>`,
    refreshFramePreview(){},renderPhoto(){},refreshManagedAudio(){},syncFrameSelection(){},refreshProcessingButton(){},refreshSpatialPanels(){},reportFramePresence(){},applyLocalDisplay(){},refreshDraftContext(){},renderFramePresence(){},detail(){},
    api:async(action,data,token,{signal})=>{const pending=deferred();calls.push({action,data,token,signal,...pending});return pending.promise}
  });
  vm.runInContext(controls+'\n'+views+"\nfunction photos(){return state?.messages.filter(message=>message.type==='photo')||[]} function current(){return state?.messages.find(message=>message._id===selected)} function renderList(force){renderFamilyMemories(force)}",context);
  const run=source=>vm.runInContext(source,context);
  const initial=state=>{context.state=context.reconcileHistory(state);context.renderList();context.refreshExperience()};
  const finishPoll=async(state)=>{const pending=calls.at(-1);assert.equal(pending.action,'state');pending.resolve(state);await tick()};
  return {context,$,calls,timers,run,initial,finishPoll,ids:()=>Array.from(context.state.messages,message=>message._id)};
}

test('load earlier memories once, deduplicate, preserve selection/draft, and do not announce old replies',async()=>{
  const f=fixture();f.initial(response([memory('m3'),memory('m4')]));
  assert.match(f.$('#homeHistoryStatus').textContent,/还有 2 段未加载/);
  assert.match(f.$('#treeHistoryScope').textContent,/仅基于已加载/);
  const loading=f.context.loadHistory();const again=f.context.loadHistory();await again;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'history');assert.equal(f.calls[0].data.cursor,'older');
  assert.equal(f.$('#treeLoadHistory').disabled,true);assert.match(f.$('#homeHistoryStatus').textContent,/正在加载/);
  f.calls[0].resolve({messages:[memory('m1',{type:'reply'}),memory('m2',{card:{people:['奶奶'],year:'1950'}}),memory('m3')],nextCursor:null,hasMore:false,total:4});await loading;
  assert.deepEqual(f.ids(),['m1','m2','m3','m4']);assert.equal(f.context.selected,'m4');assert.equal(f.context.draft.text,'saved draft');
  assert.equal(f.$('#newReplyNotice').hidden,true);assert.deepEqual(Array.from(f.calls.at(-1).data.historyIds),f.ids());
  await f.finishPoll(response([memory('m3'),memory('m4')],{old:[memory('m1',{type:'reply'}),memory('m2',{card:{people:['奶奶'],year:'1950'}})]}));
  assert.match(f.$('#homeHistoryStatus').textContent,/已全部展示/);assert.equal(f.$('#homeLoadHistory').hidden,true);
  f.context.treePerson='奶奶';f.context.renderList(true);assert.match(f.$('#treeMemories').innerHTML,/m2/);assert.doesNotMatch(f.$('#treeMemories').innerHTML,/m3/);
  f.context.treeMode='time';f.context.renderList(true);assert.match(f.$('#timelineLabel').textContent,/1950/);
  const next=f.context.poll();f.calls.at(-1).resolve(response([memory('m3'),memory('m4'),memory('m5',{type:'reply',name:'爷爷'})],{old:[memory('m1',{type:'reply'}),memory('m2')],total:5}));await next;
  assert.equal(f.$('#newReplyNotice').hidden,false);assert.match(f.$('#newReplyNotice').innerHTML,/爷爷.*新回信/);
});

test('poll refreshes old edits and media URLs, removes deleted history, and keeps the page cursor',async()=>{
  const f=fixture();f.initial(response([memory('m3'),memory('m4')]));
  f.context.state.messages.unshift(memory('m1',{imageURL:'expired'}),memory('m2'));
  f.run("historyStarted=true;historyPage.nextCursor='continue-before-m1'");
  const pending=f.context.poll();assert.deepEqual(Array.from(f.calls[0].data.historyIds),['m1','m2','m3','m4']);
  f.calls[0].resolve(response([memory('m4'),memory('m5')],{old:[memory('m1',{text:'修订文字',imageURL:'fresh-photo',audioURL:'fresh-audio'}),memory('m3')],total:5,cursor:'new-window'}));await pending;
  assert.deepEqual(f.ids(),['m1','m3','m4','m5']);assert.equal(f.context.state.messages[0].text,'修订文字');assert.equal(f.context.state.messages[0].imageURL,'fresh-photo');assert.equal(f.context.state.messages[0].audioURL,'fresh-audio');
  assert.equal(f.run('historyPage.nextCursor'),'continue-before-m1');assert.match(f.$('#memories').innerHTML,/修订文字/);
});

test('a poll completed before a history page cannot erase that page when its response arrives late',async()=>{
  const f=fixture();f.initial(response([memory('m3'),memory('m4')]));
  const oldPoll=f.context.poll(),stale=f.calls[0];const loading=f.context.loadHistory(),page=f.calls[1];assert.equal(stale.signal.aborted,true);
  page.resolve({messages:[memory('m1'),memory('m2')],nextCursor:null,hasMore:false,total:4});await loading;
  stale.resolve(response([memory('m3'),memory('m4')],{total:2}));await oldPoll;
  assert.deepEqual(f.ids(),['m1','m2','m3','m4']);
  await f.finishPoll(response([memory('m3'),memory('m4')],{old:[memory('m1'),memory('m2')]}));
  assert.deepEqual(f.ids(),['m1','m2','m3','m4']);
});

test('a refresh after removal cancels a pending history page so its late response cannot resurrect a record',async()=>{
  const f=fixture();f.initial(response([memory('m3'),memory('m4')]));
  const loading=f.context.loadHistory(),page=f.calls[0];const refresh=f.context.poll(),newState=f.calls[1];assert.equal(page.signal.aborted,true);
  newState.resolve(response([memory('m4')],{total:1,hasMore:false,cursor:null}));await refresh;
  page.resolve({messages:[memory('m1'),memory('m3')],nextCursor:null,hasMore:false,total:3});await loading;
  assert.deepEqual(f.ids(),['m4']);assert.equal(f.calls.length,2);
});

test('leaving a session aborts history and rejects a late result even after another account enters',async()=>{
  const f=fixture();f.initial(response([memory('m3'),memory('m4')]));const loading=f.context.loadHistory(),old=f.calls[0];
  f.context.resetHistory();f.context.state=null;f.context.session={token:'second',room:'other-room'};f.initial(response([memory('m8')],{total:1,hasMore:false,cursor:null}));
  old.resolve({messages:[memory('m1')],nextCursor:null,hasMore:false,total:4});await loading;
  assert.equal(old.signal.aborted,true);assert.deepEqual(f.ids(),['m8']);assert.equal(f.calls.length,1);assert.equal(f.run('historyStarted'),false);
});

test('history timeout leaves loaded records and cursor intact with an explicit retry',async()=>{
  const f=fixture();f.initial(response([memory('m3'),memory('m4')]));const loading=f.context.loadHistory(),page=f.calls[0];
  const timeout=[...f.timers.values()].find(timer=>timer.ms===12000);timeout.fn();page.reject(new DOMException('aborted','AbortError'));await loading;
  assert.deepEqual(f.ids(),['m3','m4']);assert.equal(f.run('historyPage.nextCursor'),'older');assert.match(f.$('#homeHistoryStatus').textContent,/超时/);assert.match(f.$('#treeLoadHistory').textContent,/重试/);
  await f.finishPoll(response([memory('m3'),memory('m4')]));assert.match(f.$('#homeHistoryStatus').textContent,/超时/);
  const retry=f.context.loadHistory();assert.equal(f.calls.at(-1).data.cursor,'older');
  f.calls.at(-1).reject(new Error('断网'));await retry;assert.match(f.$('#homeHistoryStatus').textContent,/断网/);
  await f.finishPoll(response([memory('m3'),memory('m4')]));
});

test('old servers retain recent browsing without offering a nonfunctional history button',async()=>{
  const f=fixture();f.initial(response([memory('m3'),memory('m4')],{legacy:true}));
  assert.equal(f.$('#homeLoadHistory').hidden,true);assert.match(f.$('#homeHistoryStatus').textContent,/暂不支持/);await f.context.loadHistory();assert.equal(f.calls.length,0);
  const polling=f.context.poll();assert.deepEqual(Object.keys(f.calls[0].data),[]);f.calls[0].resolve(response([memory('m4')],{legacy:true}));await polling;assert.deepEqual(f.ids(),['m4']);
});

test('equal timestamps have deterministic ID order and frame requests retain their original payload',async()=>{
  const f=fixture();assert.deepEqual(Array.from(f.context.orderedMemories([memory('m2',{createdAt:1}),memory('m1'),memory('m2',{createdAt:1,text:'latest'})]),m=>[m._id,m.text]),[['m1','m1'],['m2','latest']]);
  f.context.frame=true;f.initial(response([memory('m3')],{total:1,hasMore:false,cursor:null}));const polling=f.context.poll();assert.deepEqual(Object.keys(f.calls[0].data),[]);
  const state=response([],{total:0,hasMore:false,cursor:null});f.calls[0].resolve(state);await polling;assert.equal(f.calls.length,1);
});
