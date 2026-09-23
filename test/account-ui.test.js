'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const auth=fs.readFileSync(path.join(__dirname,'../server/public/account-auth.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../server/public/app.js'),'utf8');

// A form/controller unit fixture; this is not a browser rendering substitute.
function fixture(overrides={}){
  const nodes=new Map(),controls=[{disabled:false},{disabled:false}],writes=[],notices=[],calls=[];
  const button={disabled:false,textContent:'提交',isConnected:true,focus(){}};
  const $=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{hidden:false,isConnected:true,textContent:'',innerHTML:'',setAttribute(){},remove(){},focus(){},querySelectorAll(){return []},querySelector(){return button},reportValidity(){return true}});
    return nodes.get(selector);
  };
  const data={username:'family01',password:'test-password',...overrides.data};delete overrides.data;
  let enters=0,rejoins=0;
  const context=vm.createContext({$,console,AbortController,DOMException,
    frame:false,invite:'',app:{className:'',querySelectorAll:()=>controls},seenReplies:null,authScreenActive:false,pollTimer:null,presenceExpiryTimer:null,
    esc:value=>String(value??''),parseInvite:value=>value.replace('https://example.test/family#invite=',''),
    session:null,sessionExpired:false,draft:{text:'previous account draft'},key:'memory-session-family',recording:null,sending:false,
    FormData:class {constructor(){} *[Symbol.iterator](){yield* Object.entries(data)}},
    localStorage:{setItem:(key,value)=>writes.push([key,value])},setTimeout:()=>1,clearTimeout(){},
    api:async(action,data)=>{calls.push({action,data:{...data}});return {token:'session',room:'house',role:'family',name:'家人',username:'family01',password:'never-persist'}},
    loadDraft:async()=>{},saveDraft:async()=>{},applyLocalDisplay(){},shell:()=>{enters++;$('#authForm').isConnected=false},poll(){},toast:text=>notices.push(text),rejoinSession:async()=>{rejoins++},...overrides});
  vm.runInContext(auth,context);
  return {context,$,controls,button,writes,notices,calls,enters:()=>enters,rejoins:()=>rejoins,submit:()=>context.$('#authForm').onsubmit({preventDefault(){},currentTarget:$('#authForm')})};
}

test('registration keeps the returned identity and enters the family even if draft recovery fails',async()=>{
  const f=fixture({invite:'join-code',data:{nickname:'家人',mode:'join',invite:'https://example.test/family#invite=join-code'},loadDraft:async()=>{throw new Error('IndexedDB unavailable')}});
  f.context.authScreen();await f.submit();
  assert.equal(f.calls[0].action,'register');assert.equal(f.calls[0].data.invite,'join-code');assert.equal(f.enters(),1);
  const stored=JSON.parse(f.writes[0][1]);assert.equal(stored.username,'family01');assert.equal(stored.password,undefined);
  assert.deepEqual(Object.keys(f.context.draft),[]);assert.match(f.notices[0],/原草稿未删除/);
});

test('failed account authentication retains the form and re-enables all controls',async()=>{
  const f=fixture({api:async()=>{throw new Error('账号或密码不正确')}});f.context.authScreen();await f.submit();
  assert.equal(f.enters(),0);assert.equal(f.writes.length,0);assert.match(f.$('#authError').textContent,/密码/);
  assert.ok(f.controls.every(control=>!control.disabled));
});

test('family login rejects a frame identity without persisting it',async()=>{
  const f=fixture({api:async()=>({token:'frame-token',room:'house',role:'frame'})});f.context.authScreen();await f.submit();
  assert.equal(f.writes.length,0);assert.equal(f.enters(),0);assert.match(f.$('#authError').textContent,/相框端/);
});

test('an invitation screen can resume account login after logout without reusing its old invite',async()=>{
  const f=fixture({invite:'old-invite'});f.context.authScreen({resume:true});await f.submit();
  assert.equal(f.calls[0].action,'login');assert.equal(f.calls[0].data.invite,undefined);
  assert.match(f.$('#authForm').innerHTML,/current-password/);assert.doesNotMatch(f.$('#authForm').innerHTML,/value="old-invite"/);
});

test('frame access remains a pairing form with no account password',async()=>{
  const f=fixture({frame:true,invite:'frame-invite',data:{username:undefined,password:undefined,nickname:'客厅相框',invite:'frame-invite'},api:async(action)=>{assert.equal(action,'join');return {token:'frame-token',room:'house',role:'frame',name:'客厅相框'}}});
  f.context.authScreen();assert.doesNotMatch(f.$('#authForm').innerHTML,/name="password"/);await f.submit();assert.equal(f.enters(),1);
});

test('account draft keys isolate identities while retaining every legacy key',()=>{
  const source=app.slice(app.indexOf('function draftKey(){'),app.indexOf('async function saveDraft'));
  const context=vm.createContext({key:'memory-session-family',session:{room:'house'}});vm.runInContext(source,context);
  const legacy=context.draftKey();assert.equal(legacy,'memory-session-family:house');
  context.session.username='Family01';const first=context.draftKey();context.session.username='family01';assert.equal(context.draftKey(),first);
  context.session.username='family02';assert.notEqual(context.draftKey(),first);assert.notEqual(context.draftKey(),legacy);
});

test('logout retains the signed-in screen on network failure and clears it only after revocation',async()=>{
  const failed=fixture({session:{token:'session'},api:async()=>{throw new Error('offline')}});await failed.context.logoutSession();
  assert.equal(failed.rejoins(),0);assert.match(failed.notices[0],/尚未确认退出/);assert.equal(failed.$('#logout').disabled,false);
  const success=fixture({session:{token:'session'}});await success.context.logoutSession();assert.equal(success.calls[0].action,'logout');assert.equal(success.rejoins(),1);
});
