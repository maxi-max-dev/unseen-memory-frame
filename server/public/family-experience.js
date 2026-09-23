'use strict';
// The reference prototype supplies the order of the experience. All content
// comes from this family's records; no example people or memories are seeded.
let familyPage='home',treeMode='people',treePerson='',treeYear='',experienceSignature='',seenReplies=null,followFrame=true;
let presenceBusy=false,presenceQueued=false,presenceLast='',presenceAt=0;
let presenceExpiryTimer,stateReceivedAt=0;
let localDisplay={large:false,night:false};
try{localDisplay={...localDisplay,...JSON.parse(localStorage.getItem('memory-display-v1')||'{}')}}catch{}
function familyShellHTML(){return `
  <section id="familyHome" class="family-page">
    <div class="row between subheading"><div><h1 id="roomName">我们的家</h1><small id="members"></small></div><button id="familyMembers" class="avatar-link" aria-label="查看我的家">家</button></div>
    <section class="paper taped frame-preview"><div class="row between preview-heading"><span id="framePresence" class="status">等待相框状态</span><small id="framePreviewLabel">最近寄到家里的记忆</small></div><div id="photo" class="photo"></div><div id="caption" class="caption"></div><div class="row between"><button id="currentDetail" class="quiet">查看详情 ›</button><small id="position"></small></div><button id="openFramePreview" class="quiet frame-preview-entry">▣ 预览老人相框</button><div id="currentAudio"></div><div id="currentSpatial"></div><div class="row between actions"><button id="prev" aria-label="上一张">← 上一张</button><button id="next" aria-label="下一张">下一张 →</button></div></section>
    <div class="home-actions"><button id="newPhoto" class="paper"><span class="action-icon">＋</span><span><b>上传新照片</b><small>照片或 3D 空间</small></span></button><button id="newVoice" class="paper"><span class="action-icon voice-icon">●</span><span><b>录一段话给家人</b><small>留下熟悉的原声</small></span></button></div>
    <section class="paper memory-home"><button id="openTree" class="tree-entry"><span class="tree-symbol" aria-hidden="true">◎</span><span><h2>AI 族谱</h2><small id="memoryTotal">按人物和年代，找回家里的故事</small></span><span aria-hidden="true">›</span></button><p class="muted tree-note">人物由家人标注；AI 整理的内容会标明待确认。</p><div class="row between"><h2>家人讲的故事</h2><small>左右滑动看看 ›</small></div><div id="newReplyNotice" hidden></div><div id="memories" class="story-strip"></div><p id="storyScope" class="muted"></p><div class="history-controls"><p id="homeHistoryStatus" class="muted" role="status" aria-live="polite"></p><button id="homeLoadHistory" class="quiet" hidden>加载更早记忆</button></div></section>
  </section>
  <section id="familyMine" class="family-page" hidden><div class="subheading"><h1>我的家</h1><small id="mineRoom"></small></div><section class="paper"><div class="row between"><h2>记忆里的人</h2><button id="people" class="quiet">添加人物</button></div><div id="familyPeople"></div><h2>已连接的家人和相框</h2><p class="muted">按加入的设备列出；同一位家人可能使用多台设备。</p><div id="familyDevices"></div></section><section class="paper mine-stats"><div id="familyStats" class="stats-grid"></div><p id="statsScope" class="muted"></p><div class="row"><button id="invite" class="primary">邀请家人 / 配对</button><button id="mineSettings" class="quiet">设置</button></div></section></section>
  <section id="familyTree" class="family-page" hidden><div class="row between subheading"><button id="treeBack" class="quiet">‹ 返回首页</button><h1>AI 族谱</h1></div><p class="muted">按人物找故事，按年代看记忆。只显示已有标注，不推断亲属关系。</p><div class="segmented" role="tablist" aria-label="记忆浏览方式"><button id="treePeopleTab" role="tab" aria-selected="true">人物</button><button id="treeTimeTab" role="tab" aria-selected="false">时间轴</button></div><section class="paper"><div id="peopleBrowse"><div id="personNodes" class="person-nodes"></div></div><div id="timeBrowse" hidden><label for="timelineYear">截至年份</label><input id="timelineYear" type="range" min="0" max="0" value="0" disabled><p id="timelineLabel" class="muted"></p><label class="checkbox-label"><input id="unknownYears" type="checkbox" checked>包含未标注年代的记忆</label></div><div class="filters"><select id="personFilter" aria-label="按人物筛选"><option value="">全部人物</option></select><input id="yearFilter" placeholder="年份 / 原话中的时间" aria-label="按时间筛选"></div><p id="treeHistoryScope" class="muted"></p><div class="history-controls"><p id="treeHistoryStatus" class="muted" role="status" aria-live="polite"></p><button id="treeLoadHistory" class="quiet" hidden>加载更早记忆</button></div><h2 id="treeListTitle">全部记忆</h2><div id="treeMemories" class="cards"></div></section></section>
  <dialog id="composerDialog" class="composer-dialog" aria-labelledby="composerTitle"><div class="drawer-heading"><span class="drawer-grab" aria-hidden="true"></span><button id="closeComposer" class="close" aria-label="关闭发送抽屉">×</button></div>${composerHTML()}</dialog>
  <nav class="family-tabbar" aria-label="家人端导航"><button id="homeTab" class="on" aria-current="page"><span aria-hidden="true">⌂</span>首页</button><button id="plus" class="primary plus-button" aria-label="上传照片或空间">＋</button><button id="mineTab"><span aria-hidden="true">♡</span>我的</button></nav>`}
function bindFamilyShell(){
  $('#openFramePreview').onclick=openFramePreview;
  $('#familyMembers').onclick=()=>showFamilyPage('mine');$('#homeTab').onclick=()=>showFamilyPage('home');$('#mineTab').onclick=()=>showFamilyPage('mine');
  $('#openTree').onclick=()=>showFamilyPage('tree');$('#treeBack').onclick=()=>showFamilyPage('home');
  $('#currentDetail').onclick=()=>current()&&detail(current()._id);
  $('#homeLoadHistory').onclick=$('#treeLoadHistory').onclick=loadHistory;
  $('#newPhoto').onclick=$('#plus').onclick=()=>openComposer('photo');$('#newVoice').onclick=()=>openComposer('voice');
  $('#closeComposer').onclick=closeComposer;$('#composerDialog').addEventListener('cancel',e=>{e.preventDefault();closeComposer()});
  $('#photoComposeTab').onclick=()=>setComposerKind('photo');$('#spatialComposeTab').onclick=()=>setComposerKind('spatial');
  $('#detachParent').onclick=()=>{if(recording)return toast('请先结束录音');delete draft.parent;saveDraft();refreshDraftContext()};
  $('#invite').onclick=inviteDialog;$('#people').onclick=()=>state?peopleDialog():toast('家庭资料正在同步，请稍候');$('#mineSettings').onclick=()=>$('#settings').click();
  $('#personFilter').onchange=e=>{treePerson=e.target.value;renderList(true)};$('#yearFilter').oninput=()=>renderList(true);
  $('#treePeopleTab').onclick=()=>setTreeMode('people');$('#treeTimeTab').onclick=()=>setTreeMode('time');
  $('#timelineYear').oninput=e=>{treeYear=e.target.value;renderList(true)};$('#unknownYears').onchange=()=>renderList(true);
  $('#personNodes').onclick=e=>{const button=e.target.closest('[data-person]');if(button){treePerson=button.dataset.person;$('#personFilter').value=treePerson;renderList(true)}};
  bindComposer();setComposerKind(draft.kind||'photo',false);showFamilyPage('home',false);
}
function showFamilyPage(page,focus=true){
  if(frame)return;familyPage=page;
  for(const [id,name] of [['familyHome','home'],['familyMine','mine'],['familyTree','tree']])$('#'+id).hidden=name!==page;
  for(const [id,name] of [['homeTab','home'],['mineTab','mine']]){const active=page===name;$('#'+id).classList.toggle('on',active);if(active)$('#'+id).setAttribute('aria-current','page');else $('#'+id).removeAttribute('aria-current')}
  if(page==='tree')renderList(true);if(focus){window.scrollTo({top:0,behavior:'instant'});const title=$('#'+({home:'familyHome',mine:'familyMine',tree:'familyTree'}[page])+' h1');title.tabIndex=-1;title.focus({preventScroll:true})}
}
function openComposer(mode='photo'){
  if(sessionExpired)return toast('请先重新加入家庭，草稿仍在此设备');
  const hasDraft=!!(draft.image||draft.audio||draft.text||draft.link||recording);
  if(!hasDraft){setComposerKind(mode==='spatial'?'spatial':'photo');if(mode==='voice'&&current())draft.parent=current()._id;else delete draft.parent;saveDraft()}
  refreshDraftContext();$('#composerDialog').showModal();
  if(mode==='voice')$('#record').focus();else $('#closeComposer').focus();
}
function closeComposer(){if(recording)return toast('正在录音，请先结束录音并试听');$('#composerDialog').close()}
function setComposerKind(kind,persist=true){
  if(frame)return;if(recording)return toast('请先结束录音');kind=kind==='spatial'?'spatial':'photo';draft.kind=kind;
  $('#photoComposePanel').hidden=kind!=='photo';$('#spatialComposePanel').hidden=kind!=='spatial';
  $('#photoComposeTab').setAttribute('aria-selected',String(kind==='photo'));$('#spatialComposeTab').setAttribute('aria-selected',String(kind==='spatial'));
  if(persist)saveDraft().catch(()=>toast('草稿保存失败，请保持页面打开'));
}
function refreshDraftContext(){
  if(frame||!$('#draftContext'))return;const parent=state?.messages.find(m=>m._id===draft.parent);
  $('#draftContext').hidden=!draft.parent;$('#draftContextText').textContent=parent?'这段话关联：'+(parent.title||parent.card?.title||parent.text?.slice(0,28)||'当前记忆'):'关联的记忆已不在当前列表，可取消关联后发送。';
  $('#detachParent').disabled=!!recording;
}
function setTreeMode(mode){treeMode=mode;$('#peopleBrowse').hidden=mode!=='people';$('#timeBrowse').hidden=mode!=='time';$('#treePeopleTab').setAttribute('aria-selected',String(mode==='people'));$('#treeTimeTab').setAttribute('aria-selected',String(mode==='time'));renderList(true)}
function memoryYear(message){const value=message.card?.year||'';const match=/(?:^|\D)((?:18|19|20)\d{2})(?:\D|$)/.exec(value);return match?Number(match[1]):null}
function memoryReadingHTML(message){
  const tags=[...(message.card?.people||[]),message.card?.place,message.card?.year].filter(Boolean);
  const words=message.editedText||message.transcription||message.text;
  return `<div class="detail-tags">${tags.map(tag=>`<span>${esc(tag)}</span>`).join('')}</div>${words?`<div class="memory-quote">${esc(words)}<small>${esc(message.name)} · ${message.editedText?'家人修订文字':message.transcription?'原声转写':'随记忆寄来的文字'}</small></div>`:''}${message.card?.summary?`<p>${esc(message.card.summary)}</p>`:''}`;
}
function bindMemoryReading(message){
  const replies=state.messages.filter(m=>m.parent===message._id),parent=state.messages.find(m=>m._id===message.parent);
  $('#relatedMemories').innerHTML=(parent?`<button class="quiet" data-related="${esc(parent._id)}">查看这段话对应的记忆 ›</button>`:'')+(replies.length?'<h3>家人围绕它说的话</h3>'+replies.map(m=>`<button class="memory" data-related="${esc(m._id)}"><span><b>${esc(m.name)}的回信</b><small>${esc((m.editedText||m.transcription||m.text||'点开收听原声').slice(0,80))}</small></span></button>`).join(''):'');
  $('#relatedMemories').querySelectorAll('[data-related]').forEach(button=>button.onclick=()=>{if($('#editForm')?.dataset.dirty==='true'&&!confirm('尚有未保存修订，离开这份记忆？'))return;detail(button.dataset.related)});
  $('#editForm').addEventListener('input',()=>{$('#editForm').dataset.dirty='true'});
  $('#copyMemory').onclick=async()=>{const text=[message.title||message.card?.title||'一份家里的记忆',message.editedText||message.transcription||message.text||'',message.card?.summary?`${message.card.confirmed?'家人确认摘要':'AI 待确认摘要'}：${message.card.summary}`:'',`来自 ${message.name}`].filter(Boolean).join('\n\n');try{await navigator.clipboard.writeText(text);toast('记忆文字已复制，可自行分享给家人')}catch{prompt('复制这份记忆文字',text)}};
}
function memoryButton(message){return `<button class="memory" data-memory="${esc(message._id)}">${message.imageURL?`<img src="${esc(message.imageURL)}" alt="">`:'<span class="memory-symbol" aria-hidden="true">✉</span>'}<span><b>${esc(message.title||message.card?.title||(message.type==='reply'?'相框里的回信':'一份新记忆'))}</b><small>${esc((message.card?.summary||message.editedText||message.transcription||message.text||'点开收听或补充这份记忆').slice(0,90))}</small><small>${esc(message.name)} · ${esc(message.card?.year||'未标注年代')}</small><span class="status">${esc(aiLabel(message))}</span>${message.spatial?` <span class="status spatial-badge">${esc(spatialLabel(message.spatial.status))}</span>`:''}</span></button>`}
function renderHistoryControls(){
  if(frame||!$('#homeLoadHistory'))return;
  const count=state?.messages.length||0,total=historyPage?.total,remaining=Number.isSafeInteger(total)?Math.max(0,total-count):null;
  const scope=remaining===null?`当前可浏览 ${count} 段记忆`:`已加载 ${count} / ${total} 段记忆${remaining?` · 还有 ${remaining} 段未加载`:''}`;
  $('#memoryTotal').textContent=scope+' · 人物 / 时间轴';
  $('#storyScope').textContent=scope+'。AI 待确认内容请家人核对后保存。';
  $('#treeHistoryScope').textContent=remaining===0?'人物与时间筛选覆盖全部已加载记忆。':'人物、年代与数量仅基于已加载记忆；加载更早记忆后可继续查找。';
  const status=sessionExpired?'登录已失效，请重新登录后继续浏览':historyRequest?'正在加载更早记忆…':historyError||(!state?'记忆正在同步…':!historyPage?'当前服务暂不支持加载更早记忆；仅展示最近可浏览内容。':historyPage.hasMore?scope:'已全部展示 · '+count+' 段记忆');
  for(const prefix of ['home','tree']){
    const button=$('#'+prefix+'LoadHistory'),label=$('#'+prefix+'HistoryStatus');
    button.hidden=!historyPage?.hasMore;button.disabled=!!historyRequest||sessionExpired;
    button.textContent=historyRequest?'正在加载…':historyError?'重试加载更早记忆':'加载更早记忆';
    button.setAttribute('aria-describedby',prefix+'HistoryStatus');
    label.textContent=status;label.classList.toggle('error',!!historyError);label.setAttribute('aria-busy',String(!!historyRequest));
  }
}
function renderFamilyMemories(force=false){
  if(frame||!state)return;renderHistoryControls();const yearText=$('#yearFilter').value.trim();const sig=JSON.stringify([state.messages,state.people,treePerson,treeYear,treeMode,yearText,$('#unknownYears').checked]);if(!force&&sig===listSignature)return;listSignature=sig;
  const focused=document.activeElement,focusPerson=focused?.dataset.person,focusMemory=focused?.dataset.memory,focusRoot=focused?.closest('#treeMemories')?'#treeMemories':'#memories';
  const messages=state.messages,names=[...new Set([...state.people.map(p=>p.name),...messages.flatMap(m=>m.card?.people||[])])];
  $('#personFilter').innerHTML='<option value="">全部人物</option>'+names.map(name=>`<option value="${esc(name)}" ${name===treePerson?'selected':''}>${esc(name)}</option>`).join('');
  $('#personNodes').innerHTML=[['','全部记忆'],...names.map(name=>[name,name])].map(([name,label])=>`<button data-person="${esc(name)}" class="person-node ${name===treePerson?'selected':''}" aria-pressed="${name===treePerson}"><span class="person-avatar">${esc(name?name.slice(0,1):'家')}</span><b>${esc(label)}</b><small>${messages.filter(m=>!name||m.card?.people?.includes(name)).length} 段记忆</small></button>`).join('');
  const years=messages.map(memoryYear).filter(year=>year!==null);const min=years.length?Math.min(...years):0,max=years.length?Math.max(...years):0;
  const range=$('#timelineYear');range.disabled=!years.length;range.min=min;range.max=max;range.value=treeYear?Math.max(min,Math.min(max,Number(treeYear))):max;
  $('#timelineLabel').textContent=years.length?`${min} — ${range.value} 年 · 年代来自记忆标注`:'还没有标注可排序年份的记忆。可在记忆详情中补充年份。';
  let items=messages.filter(m=>(!treePerson||m.card?.people?.includes(treePerson))&&(!yearText||(m.card?.year||'').includes(yearText)));
  if(treeMode==='time')items=items.filter(m=>memoryYear(m)===null?$('#unknownYears').checked:memoryYear(m)<=Number(range.value)).sort((a,b)=>(memoryYear(a)??Infinity)-(memoryYear(b)??Infinity)||a.createdAt-b.createdAt);else items=items.slice().reverse();
  $('#treeListTitle').textContent=(treePerson?treePerson+'的记忆':'全部记忆')+' · '+items.length;
  $('#treeMemories').innerHTML=items.length?items.map(m=>(treeMode==='time'?`<p class="timeline-date">${esc(m.card?.year||'年代待补充')}</p>`:'')+memoryButton(m)).join(''):'<p class="empty">已加载的记忆中，没有符合这个人物或年代的故事。<br>可调整筛选，或继续加载更早记忆。</p>';
  const stories=messages.slice().reverse();$('#memories').innerHTML=stories.length?stories.map(memoryButton).join(''):'<div class="empty">还没有家里的故事。<br>寄一张照片，录一段熟悉的声音。</div>';
  for(const root of [$('#memories'),$('#treeMemories')])root.querySelectorAll('[data-memory]').forEach(button=>button.onclick=()=>detail(button.dataset.memory));

  if(focusPerson!==undefined)[...$('#personNodes').querySelectorAll('[data-person]')].find(button=>button.dataset.person===focusPerson)?.focus({preventScroll:true});
  else if(focusMemory)[...$(focusRoot).querySelectorAll('[data-memory]')].find(button=>button.dataset.memory===focusMemory)?.focus({preventScroll:true});
}
function refreshExperience(){
  refreshFramePreview();applyLocalDisplay();if(frame||!state||!$('#familyMine'))return;
  $('#currentDetail').disabled=!current();$('#mineRoom').textContent=state.room.name+' · 家庭空间';refreshDraftContext();
  const signature=JSON.stringify([state.people,state.members,state.stats]);if(signature!==experienceSignature){experienceSignature=signature;
    $('#familyPeople').innerHTML=state.people.length?state.people.map(p=>`<div class="member-row"><span class="person-avatar">${esc(p.name.slice(0,1))}</span><div><b>${esc(p.name)}</b><small>${esc(p.relation||'关系未补充')}</small></div></div>`).join(''):'<p class="empty">还没有添加人物。用家人的真实称呼，慢慢补齐记忆。</p>';
    $('#familyDevices').innerHTML=state.members.map(m=>`<div class="member-row"><span class="person-avatar ${m.role==='frame'?'frame-avatar':''}">${m.role==='frame'?'▣':'家'}</span><div><b>${esc(m.name)}</b><small>${m.role==='frame'?'相框设备':m.username?'账号 '+esc(m.username):m.role==='owner'?'家庭创建者':'家人设备'} · ${m.online?'在线':'离线'}</small></div></div>`).join('');
    renderFamilyStats();
  }
  renderFramePresence();
  const replies=state.messages.filter(m=>m.type==='reply');if(seenReplies===null)seenReplies=new Set(replies.map(m=>m._id));else{const fresh=replies.filter(m=>!seenReplies.has(m._id));fresh.forEach(m=>seenReplies.add(m._id));if(fresh.length){const latest=fresh.at(-1);$('#newReplyNotice').hidden=false;$('#newReplyNotice').innerHTML=`<button class="new-reply">收到 ${esc(latest.name)} 的新回信 · 点开听听 ›</button>`;$('#newReplyNotice button').onclick=()=>{$('#newReplyNotice').hidden=true;detail(latest._id)}}}
}
function renderFamilyStats(){
  const stats=state.stats;
  $('#familyStats').innerHTML=[['photos','照片'],['voices','原声'],['spatial','3D 空间']].map(([key,label])=>`<div><b>${Number.isSafeInteger(stats?.[key])?stats[key]:'—'}</b><small>${label}</small></div>`).join('');
  $('#statsScope').textContent=stats?`全家庭 ${stats.memories} 条未移除记忆，含 ${stats.replies} 条回信。按记忆条数统计，一条记忆可同时有照片、原声和空间。`:'家庭统计等待服务端同步。';
}
function framePresenceRemaining(){
  const presence=state?.framePresence;
  if(!presence?.online||!Number.isFinite(presence.expiresAt)||!Number.isFinite(state.serverTime))return 0;
  return Math.max(0,presence.expiresAt-state.serverTime-Math.max(0,performance.now()-stateReceivedAt));
}
function renderFramePresence(){
  clearTimeout(presenceExpiryTimer);
  if(frame||!state||!$('#framePresence'))return;
  if(sessionExpired||failures){$('#framePresence').textContent=sessionExpired?'登录已失效 · 状态待更新':'连接中断 · 状态待更新';$('#framePreviewLabel').textContent='上次同步的记忆';if($('#frameNowNote'))$('#frameNowNote').hidden=true;return}
  const presence=state.framePresence,frames=state.members.filter(m=>m.role==='frame');
  const remaining=framePresenceRemaining(),online=remaining>0;
  if(online)presenceExpiryTimer=setTimeout(renderFramePresence,Math.ceil(remaining)+1);
  const activity={viewing:'正在看记忆',listening:'正在听原声',recording:'正在说一说',spatial:'正在看空间',idle:'待机中'};
  $('#framePresence').textContent=online?`${presence.frameName||'相框'} · ${activity[presence.activity]||'在线'}`:frames.length?'相框当前状态未同步':'尚未配对相框';
  $('#framePreviewLabel').textContent=online&&presence.messageId===selected?'相框正在展示的记忆':online&&presence.messageId?'你正在浏览其他记忆':'最近寄到家里的记忆';
  let note=$('#frameNowNote');if(!note){note=document.createElement('p');note.id='frameNowNote';note.className='muted frame-now-note';$('.preview-heading').after(note)}
  if(online&&presence.message&&presence.messageId!==selected){note.replaceChildren();const label=document.createElement('span');label.textContent='相框现在：'+(presence.message.title||'一份家里的记忆')+' ';note.append(label);if(state.messages.some(m=>m._id===presence.messageId)){const button=document.createElement('button');button.className='quiet';button.textContent='跟随相框';button.onclick=()=>{followFrame=true;syncFrameSelection();renderPhoto();refreshExperience()};note.append(button)}else{const text=document.createElement('span');text.textContent='（不在最近可浏览列表中）';note.append(text)}note.hidden=false}else note.hidden=true;
}
function syncFrameSelection(){if(!frame&&followFrame&&framePresenceRemaining()>0&&state.messages.some(m=>m._id===state.framePresence.messageId))selected=state.framePresence.messageId}
async function reportFramePresence(force=false){
  if(!frame||!session||sessionExpired||!state?.framePresence)return;
  if(presenceBusy){presenceQueued=presenceQueued||force;return}
  let activity='idle',messageId='';
  if(!document.hidden&&!document.documentElement.classList.contains('night-view')&&current()){
    activity=recording?'recording':spatialView?.ready?'spatial':frameAudio&&!frameAudio.paused&&!frameAudio.ended?'listening':spatialView?'idle':'viewing';
    messageId=activity==='recording'?recording.parent:activity==='spatial'?spatialView.id:activity==='listening'?frameAudio.dataset.message:activity==='viewing'?current()._id:'';
  }
  const signature=JSON.stringify([messageId,activity]);if(!force&&signature===presenceLast&&Date.now()-presenceAt<15000)return;
  presenceBusy=true;const token=session.token,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{await api('framePresence',{messageId,activity},token,{signal:controller.signal});if(session?.token===token){presenceLast=signature;presenceAt=Date.now()}}catch(error){if(error.status!==401)console.warn('相框活动状态暂未同步')}finally{clearTimeout(timer);presenceBusy=false;if(presenceQueued){presenceQueued=false;reportFramePresence(true)}}
}
function applyLocalDisplay(){
  document.documentElement.classList.toggle('large-text',!!localDisplay.large);
  const hour=new Date().getHours(),busy=typeof recording!=='undefined'&&(recording||(typeof frameAudio!=='undefined'&&frameAudio&&!frameAudio.paused)||spatialView),night=frame&&!!session&&!authScreenActive&&localDisplay.night&&!busy&&(hour>=22||hour<7);
  document.documentElement.classList.toggle('night-view',night);
  let clock=document.querySelector('#nightClock');if(!clock){clock=document.createElement('button');clock.id='nightClock';clock.innerHTML='<b></b><span>夜间时钟 · 点一下关闭此模式</span>';clock.onclick=()=>{document.documentElement.classList.remove('night-view');localDisplay.night=false;persistDisplay()};document.body.append(clock)}
  clock.querySelector('b').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
}
document.addEventListener('visibilitychange',()=>{if(typeof session!=='undefined')reportFramePresence(true)});
function persistDisplay(){try{localStorage.setItem('memory-display-v1',JSON.stringify(localDisplay))}catch{toast('浏览器无法保存设置，下次打开可能恢复默认')}applyLocalDisplay();reportFramePresence(true)}
function addDisplaySettings(){
  const section=document.createElement('section');section.className='display-settings';section.innerHTML=`<h3>此设备的显示</h3><label class="checkbox-label"><input id="largeTextSetting" type="checkbox" ${localDisplay.large?'checked':''}>大字模式</label>${frame?`<label class="checkbox-label"><input id="nightSetting" type="checkbox" ${localDisplay.night?'checked':''}>夜间时钟（本机时间 22:00–7:00）</label><small>只隐藏页面内容，不关闭设备屏幕；正在录音或播放时不切换。</small>`:'<small>只影响当前设备。相框夜间时钟请在相框的设置中开启。</small>'}`;
  $('#modalBody').insertBefore(section,$('#logout'));$('#largeTextSetting').onchange=e=>{localDisplay.large=e.target.checked;persistDisplay()};if($('#nightSetting'))$('#nightSetting').onchange=e=>{localDisplay.night=e.target.checked;persistDisplay()};
}

// Family-only preview: isolated selection, no frame session, presence or receipts.
let framePreviewId='',framePreviewSignature='';
function closeFramePreview(){const dialog=$('#familyFramePreview');if(dialog){dialog.close();dialog.remove()}framePreviewId='';framePreviewSignature=''}
function openFramePreview(){
 if(frame||sessionExpired||!state)return;closeFramePreview();framePreviewId=current()?._id||'';
 const dialog=document.createElement('dialog');dialog.id='familyFramePreview';dialog.className='frame-preview-dialog';dialog.setAttribute('aria-labelledby','framePreviewTitle');
 dialog.innerHTML='<div class="row between"><h2 id="framePreviewTitle">老人相框 · 预览</h2><button id="closeFramePreview" aria-label="关闭相框预览">关闭 ×</button></div><p class="muted">仅预览画面，不会切换家中相框或标记已读。</p><section class="preview-stage"><div id="previewPhoto" class="photo"></div><div id="previewCaption" class="caption"></div><div class="preview-keys" aria-label="相框按钮示意"><span class="green">▶ 听原声</span><span class="red">● 说一说</span></div></section><div class="row between preview-navigation"><button id="previewPrev" aria-label="预览上一张">← 上一张</button><small id="previewPosition"></small><button id="previewNext" aria-label="预览下一张">下一张 →</button></div>';
 document.body.append(dialog);$('#closeFramePreview').onclick=closeFramePreview;dialog.addEventListener('cancel',event=>{event.preventDefault();closeFramePreview()});
 const navigate=step=>{const items=photos();if(!items.length)return;framePreviewId=items[(Math.max(0,items.findIndex(item=>item._id===framePreviewId))+step+items.length)%items.length]._id;refreshFramePreview()};
 $('#previewPrev').onclick=()=>navigate(-1);$('#previewNext').onclick=()=>navigate(1);dialog.showModal();refreshFramePreview();
}
function refreshFramePreview(){
 if(!$('#familyFramePreview'))return;if(frame||sessionExpired||!state||!session){closeFramePreview();return}
 const items=photos();let message=items.find(item=>item._id===framePreviewId);if(!message){message=items.at(-1);framePreviewId=message?._id||''}
 const signature=JSON.stringify([message,items.length]);if(signature===framePreviewSignature)return;framePreviewSignature=signature;
 $('#previewPhoto').innerHTML=message?.imageURL?`<img src="${esc(message.imageURL)}" alt="${esc(message.title||'家人寄来的照片')}">`:`<div class="empty"><h2>${message?'一封家书':'还没有照片'}</h2><p>${message?'家人的话，也值得珍藏。':'寄来第一张照片，这里就会有家的记忆。'}</p></div>`;
 $('#previewCaption').innerHTML=message?`<h2>${esc(message.title||'家人寄来的想念')}</h2><p>${esc(message.editedText||message.text||'')}</p><small>${esc(message.name)}</small>`:'';
 $('#previewPosition').textContent=items.length?`${items.indexOf(message)+1} / ${items.length}`:'暂无记忆';$('#previewPrev').disabled=$('#previewNext').disabled=items.length<2;
}
window.addEventListener('pagehide',closeFramePreview);
