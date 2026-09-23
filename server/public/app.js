'use strict';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const frame=location.pathname==='/frame', key='memory-session-'+(frame?'frame':'family');
function storedSession(){try{const value=JSON.parse(localStorage.getItem(key)||'null');if(value&&typeof value.token==='string'&&value.token&&typeof value.room==='string'&&['owner','family','frame'].includes(value.role))return value}catch{}try{localStorage.removeItem(key)}catch{}return null}
let session=storedSession(), sessionExpired=false, authScreenActive=false, state=null, selected='', draft={}, recording=null, recordingStarting=false, recordingGeneration=0, stateRoundTripMs=0, pollTimer, failures=0, listSignature='', lastPhoto='', sending=false, db;
const invitationURL=new URL(location.href);const invite=invitationURL.searchParams.get('invite')||new URLSearchParams(invitationURL.hash.slice(1)).get('invite')||'';if(invitationURL.searchParams.has('invite')||invitationURL.hash){invitationURL.searchParams.delete('invite');invitationURL.hash='';history.replaceState(null,'',invitationURL.pathname+invitationURL.search)}
function parseInvite(value){try{const url=new URL(value);return url.searchParams.get('invite')||new URLSearchParams(url.hash.slice(1)).get('invite')||value}catch{return value.trim()}}
const app=$('#app');
function toast(t){const element=$('#toast')||document.createElement('div');element.id='toast';element.setAttribute('role','status');const host=$('#spatialDialog').open?$('#spatialDialog'):$('#modal').open?$('#modal'):$('#composerDialog')?.open?$('#composerDialog'):document.body;host.append(element);element.textContent=t;element.hidden=false;clearTimeout(element._timer);element._timer=setTimeout(()=>element.hidden=true,4500)}
function modal(html){$('#modalBody audio')?.pause();$('#modalBody').innerHTML=html;$('#modal').showModal()}
$('#closeModal').onclick=()=>$('#modal').close();$('#modal').addEventListener('close',()=>$('#modalBody audio')?.pause());
function sessionError(message){const error=new Error(message||'登录已失效，请重新登录或加入家庭');error.status=401;return error}
function expireSession(message){cancelRecordingStart();globalThis.MemoryPresence?.close('session');globalThis.MemoryPresenceSettings?.close();closeFramePreview();globalThis.MemoryAI?.dispose(true);globalThis.MemoryContact?.dispose();document.querySelector("#openContact")?.remove();sessionExpired=true;cancelHistory();if(!frame)renderHistoryControls();releaseSpatialSession();refreshSpatialPanels();if(!frame&&$('#framePresence'))renderFramePresence();clearTimeout(pollTimer);$('#connection').textContent='登录已失效';const el=$('#syncError');if(el){el.hidden=false;el.textContent=(message||'登录已过期或设备已被移除')+(frame?'。草稿保留在此设备，重新配对原家庭即可恢复。':'。草稿保留在此设备，重新登录原家庭账号即可恢复；免账号用户需邀请再次加入。')}if(!$('#rejoinSession')){const button=document.createElement('button');button.id='rejoinSession';button.textContent=frame?'重新配对':'重新登录';button.onclick=rejoinSession;$('#connection').after(button)}saveDraft().catch(()=>toast('草稿保存失败，请保持页面打开'))}
async function rejoinSession({save=true}={}){cancelRecordingStart();globalThis.MemoryPresence?.close('session');globalThis.MemoryPresenceSettings?.close();closeFramePreview();globalThis.MemoryAI?.dispose(true);globalThis.MemoryContact?.dispose();document.querySelector("#openContact")?.remove();if(sending)return toast('正在寄出记忆，请等待完成后再切换登录');if(recording)return toast('请先结束录音，保存草稿后再重新登录或配对');if(save){try{await saveDraft()}catch{return toast('草稿保存失败，请保持页面打开后重试')}}clearTimeout(pollTimer);releaseSpatialSession();if(frameAudio){frameAudio.pause();frameAudio=null}document.querySelectorAll('audio').forEach(a=>a.pause());try{localStorage.removeItem(key)}catch{}resetHistory();session=null;sessionExpired=false;state=null;selected='';lastPhoto='';listSignature='';$('#rejoinSession')?.remove();$('#settings').hidden=true;if($('#frameMenu')){$('#frameMenu').hidden=true;$('#frameMenu').open=false}document.body.classList.remove('elder-frame');$('#modal').close();$('#composerDialog')?.close();authScreen({resume:true})}
async function api(action,data={},auth=session?.token,options={}){if(auth&&auth===session?.token&&sessionExpired)throw sessionError();const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:JSON.stringify({action,data}),signal:options.signal});const result=await r.json();if(!r.ok){const error=new Error(result.error||'请求失败，请重试');error.status=r.status;if(r.status===401&&auth&&auth===session?.token)expireSession(error.message);throw error}return result}
async function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open('memory-frame-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function draftKey(){return key+':'+(session?.room||'guest')+(session?.username?':account:'+session.username.toLowerCase():'')}
async function saveDraft(){if(!db)return;return new Promise((resolve,reject)=>{const t=db.transaction('drafts','readwrite');t.objectStore('drafts').put(draft,draftKey());t.oncomplete=resolve;t.onerror=()=>reject(t.error)})}
async function loadDraft(){if(!db)return;draft=await new Promise((resolve,reject)=>{const r=db.transaction('drafts').objectStore('drafts').get(draftKey());r.onsuccess=()=>resolve(r.result||{});r.onerror=()=>reject(r.error)})}
function shell(){
  authScreenActive=false;document.body.classList.toggle('elder-frame',frame);
  resetHistory();
  lastPhoto='';listSignature='';experienceSignature='';seenReplies=null;treePerson='';treeYear='';followFrame=true;
  app.className=frame?'frame':'family-experience';$('#settings').hidden=false;
  app.innerHTML=frame?`<div class="row between subheading"><div><h1 id="roomName">我们的家</h1><small id="members"></small></div><span id="clock"></span></div><section class="paper elder-stage"><div id="photo" class="photo"></div><div id="caption" class="caption"></div><div id="currentSpatial"></div><div class="row between actions"><button id="prev" aria-label="上一张">← 上一张</button><small id="position"></small><button id="next" aria-label="下一张">下一张 →</button></div><div class="row frame-controls"><button id="listen" class="green">▶ 听原声</button><button id="record" class="red">● 说一说</button></div><p class="frame-guidance">绿色听家人的原声，红色讲讲这份记忆。</p></section><div id="recorder" class="recording" hidden></div>`:familyShellHTML();
  const error=document.createElement('div');error.id='syncError';error.className='error';error.hidden=true;app.append(error);
  $('#prev').onclick=()=>move(-1);$('#next').onclick=()=>move(1);
  if(frame){$('#record').onclick=startRecording;$('#listen').onclick=listen;updateClock()}else bindFamilyShell();
  renderDraft();applyLocalDisplay();globalThis.MemoryAI?.mount();if(globalThis.MemoryContact&&!document.querySelector("#openContact")){const contactButton=document.createElement("button");contactButton.id="openContact";contactButton.textContent="联系家人";contactButton.onclick=()=>MemoryContact.open();$("#settings").before(contactButton)}
  if(frame)mountFrameMenu();
}
function composerHTML(){return `<div class="composer"><h2 id="composerTitle">发给家里的相框</h2><div class="segmented" role="tablist" aria-label="发送内容类型"><button id="photoComposeTab" role="tab" aria-selected="true">照片</button><button id="spatialComposeTab" role="tab" aria-selected="false">3D 空间</button></div><div class="form"><section id="photoComposePanel"><label class="photo-drop">选一张今天的照片<input id="file" type="file" accept="image/*"></label><img id="draftImage" class="preview" hidden alt="待发送照片"><p class="muted">照片中的人物和年代，可以寄出后在记忆详情里由家人补充。</p></section><section id="spatialComposePanel" hidden><label>粘贴影石时光舱分享链接或文字<input id="draftLink" type="text" inputmode="url" maxlength="2000" placeholder="https://app.insta360.com/3dspace/detail/…" aria-describedby="spatialLinkHint"></label><small id="spatialLinkHint" role="status" aria-live="polite"></small><details><summary>在哪里复制作品链接？</summary><p class="muted">在影石 App 打开已生成的时光舱作品，选择分享，再选择“网页链接分享”。复制后粘贴到这里，点“寄出并导入空间”。</p><p class="muted">此处导入已经生成的 3D 作品。普通视频和时光舱特效视频不能直接变为空间，也不接收本地 SOG / ZIP 文件。</p></details></section><div id="draftContext" class="draft-context" hidden><span id="draftContextText"></span><button id="detachParent" class="quiet">取消关联</button></div><label>写一句话（可选）<textarea id="draftText" maxlength="3000" placeholder="这张照片是哪一年拍的？给我讲讲吧。"></textarea></label><div class="row"><button id="record" class="red">● 录一段原声</button><small>真实录音 · 最长 60 秒</small></div><div id="recorder" class="recording" hidden></div><button id="send" class="primary full">寄到相框</button><div class="row between"><small id="draftStatus">草稿保存在此设备</small><button id="discard" class="quiet">清空草稿</button></div><small>照片和空间可以一同发送；切换标签不会清除已选内容。</small></div></div>`}
function bindComposer(){$('#file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{draft.image=await compress(f);delete draft.imageId;delete draft.parent;await saveDraft();renderDraft()}catch(e){toast(e.message)}};$('#draftText').oninput=e=>{draft.text=e.target.value;saveDraft().catch(()=>toast('草稿保存失败，请保持页面打开'))};$('#draftLink').oninput=e=>{draft.link=e.target.value;refreshLinkHint();saveDraft().catch(()=>toast('草稿保存失败，请保持页面打开'))};$('#record').onclick=startRecording;$('#send').onclick=send;$('#discard').onclick=async()=>{if(recording)return toast('请先结束录音');draft={};await saveDraft();renderDraft()}}
async function compress(file){const bitmap=await createImageBitmap(file);const scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));const c=document.createElement('canvas');c.width=Math.round(bitmap.width*scale);c.height=Math.round(bitmap.height*scale);c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);bitmap.close();const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.85));if(!blob||blob.size>3000000)throw new Error('照片过大，请换一张照片');return blob}
function previewURL(blob){return URL.createObjectURL(blob)}
function renderDraft(){if(!frame)refreshDraftContext();if(!frame){$('#draftText').value=draft.text||'';$('#draftLink').value=draft.link||'';refreshLinkHint();const img=$('#draftImage');if(img.dataset.url)URL.revokeObjectURL(img.dataset.url);img.hidden=!draft.image;if(draft.image){img.src=img.dataset.url=previewURL(draft.image)}$('#send').disabled=sending||!!recording;$('#record').disabled=sending;$('#draftStatus').textContent=draft.image||draft.audio||draft.text||draft.link?'草稿已恢复 / 自动保存在此设备':'草稿保存在此设备'}if(recording)return;const el=$('#recorder');el.hidden=!draft.audio;if(draft.audio){el.innerHTML=`<b>原声已录好 · ${Math.round(draft.duration||0)} 秒</b><p class="muted">${frame?'这段录音已关联开始时的照片。':''}试听后再发送。</p><audio controls src="${previewURL(draft.audio)}"></audio><div class="row"><button id="retryRecord" class="quiet">重新录音</button>${frame?'<button id="sendRecording" class="primary">发送给家人</button>':''}</div>`;$('#retryRecord').onclick=startRecording;if(frame)$('#sendRecording').onclick=send}}
function cancelRecordingStart(){recordingGeneration++;recordingStarting=false}
async function startRecording(){
  if(recording||recordingStarting)return;
  if(!session||sessionExpired||authScreenActive||document.hidden)return;
  if(globalThis.MemoryRealtime?.busy())return toast('请先挂断 AI 实时对话');
  if(frame&&!current())return toast('等待家人寄来第一张照片后，再说一说');
  if(!navigator.mediaDevices?.getUserMedia)return toast('此浏览器无法录音，请使用 HTTPS 页面并允许麦克风');
  const parent=frame?current()._id:(draft.parent||''),token=session.token,generation=++recordingGeneration;
  const active=()=>generation===recordingGeneration&&session?.token===token&&!sessionExpired&&!authScreenActive&&!document.hidden;
  let stream,context,source,processor,silent,installed=false;
  recordingStarting=true;globalThis.MemoryPresence?.guard();
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:true});if(!active())return;
    context=new AudioContext();await context.resume();if(!active())return;
    const button=$('#record'),element=$('#recorder');if(!button||!element)return;
    source=context.createMediaStreamSource(stream);processor=context.createScriptProcessor(4096,1,1);silent=context.createGain();silent.gain.value=0;
    const chunks=[],rec={stream,context,source,processor,silent,chunks,parent,start:Date.now(),samples:0};
    processor.onaudioprocess=e=>{if(recording!==rec)return;const a=e.inputBuffer.getChannelData(0);chunks.push(new Float32Array(a));rec.samples+=a.length};
    source.connect(processor);processor.connect(silent);silent.connect(context.destination);
    element.hidden=false;element.innerHTML='<b id="recordTime">正在录音 · 0 / 60 秒</b><p class="muted">请自然地说话，最多录制 60 秒。</p><button id="stopRecord" class="red">■ 结束录音并试听</button>';
    $('#stopRecord').onclick=stopRecording;button.disabled=true;if($('#send'))$('#send').disabled=true;
    recording=rec;installed=true;reportFramePresence(true);
    rec.timer=setInterval(()=>{if(recording!==rec)return;const seconds=Math.floor((Date.now()-rec.start)/1000);if($('#recordTime'))$('#recordTime').textContent='正在录音 · '+seconds+' / 60 秒';if(seconds>=60)stopRecording()},250);
  }catch(e){if(active())toast(e.name==='NotAllowedError'?'麦克风未获允许，请在浏览器设置中开启后重试':e.message)}
  finally{
    if(!installed){for(const node of [processor,source,silent]){try{node?.disconnect()}catch{}}stream?.getTracks().forEach(track=>track.stop());try{await context?.close()}catch{}}
    if(generation===recordingGeneration)recordingStarting=false;
  }
}

async function stopRecording(){const rec=recording;if(!rec)return;recording=null;reportFramePresence(true);clearInterval(rec.timer);rec.processor.disconnect();rec.source.disconnect();rec.silent.disconnect();rec.stream.getTracks().forEach(t=>t.stop());try{const input=rec.context.createBuffer(1,Math.max(1,rec.samples),rec.context.sampleRate);let offset=0;for(const c of rec.chunks){input.getChannelData(0).set(c,offset);offset+=c.length}const length=Math.min(960000,Math.floor(input.duration*16000));if(length<1600)throw new Error('录音太短，请再说一段');const offline=new OfflineAudioContext(1,length,16000),source=offline.createBufferSource();source.buffer=input;source.connect(offline.destination);source.start();const output=await offline.startRendering();draft.audio=wav(output.getChannelData(0));draft.duration=length/16000;draft.parent=rec.parent;delete draft.audioId;await saveDraft();renderDraft()}catch(e){toast(e.message)}finally{await rec.context.close();$('#record').disabled=false;if($('#send'))$('#send').disabled=false}}
function wav(samples){const buffer=new ArrayBuffer(44+samples.length*2),v=new DataView(buffer);const str=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));str(0,'RIFF');v.setUint32(4,36+samples.length*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,samples.length*2,true);samples.forEach((s,i)=>v.setInt16(44+i*2,Math.max(-1,Math.min(1,s))*(s<0?32768:32767),true));return new Blob([buffer],{type:'audio/wav'})}
async function base64(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(blob)})}
async function send(){
  if(sending||recording)return;
  sending=true;
  const button=frame?$('#sendRecording'):$('#send');
  if(button){button.disabled=true;button.textContent='正在发送…'}
  try{
    const input=globalThis.MemorySpatialLink.inspect(draft.link);
    if(input.kind==='invalid')throw new Error(input.hint);
    if(input.kind==='share')draft.link=input.url;
    draft.id ||= crypto.randomUUID();await saveDraft();
    if(draft.image&&!draft.imageId){draft.imageId=(await api('upload',{base64:await base64(draft.image)})).id;await saveDraft()}
    if(draft.audio&&!draft.audioId){draft.audioId=(await api('upload',{base64:await base64(draft.audio)})).id;await saveDraft()}
    const result=await api('send',{id:draft.id,image:draft.imageId,audio:draft.audioId,text:draft.text,link:draft.link,parent:draft.parent});
    const hasAudio=!!draft.audio,hasSpatial=eligibleSpatialLink(draft.link);
    draft={};
    if(!frame){$('#composerDialog').close();showFamilyPage('home');followFrame=false;selected=result.id}
    await saveDraft();
    toast(hasSpatial?'作品已寄出，正在导入空间':'已寄出，等待另一端接收');
    await poll();
    if(hasSpatial){
      if(state?.messages.some(m=>m._id===result.id)){
        void importSpatial(result.id);
        $('#currentSpatial')?.scrollIntoView({block:'center',behavior:'smooth'});
      }else toast('作品已寄出，等待列表同步后可点“导入空间”');
    }
    if(hasAudio)processMemory(result.id);
  }catch(e){toast(e.message+'；草稿已保留，可重试')}
  finally{
    sending=false;renderDraft();
    if(button?.isConnected){button.disabled=false;button.textContent=frame?'发送给家人':'寄到相框';if(!frame)refreshLinkHint()}
  }
}
function current(){return state?.messages.find(m=>m._id===selected)}function photos(){return state?.messages.filter(m=>m.type==='photo')||[]}
function move(n){if(!frame)followFrame=false;const p=photos();if(!p.length)return;selected=p[(Math.max(0,p.findIndex(m=>m._id===selected))+n+p.length)%p.length]._id;renderPhoto();refreshExperience();reportFramePresence(true)}
function renderPhoto(){const p=photos();if(!current())selected=p.at(-1)?._id||'';const m=current();const spatialSlot=$('#currentSpatial');spatialSlot.dataset.spatialMessage=m?._id||'';refreshSpatialPanels();const signature=JSON.stringify([m?._id,m?.imageURL,m?.text,m?.title,m?.audioURL,m?.editedText,m?.link,state?.receipts]);if(signature===lastPhoto)return;lastPhoto=signature;$('#photo').innerHTML=m?.imageURL?`<img src="${esc(m.imageURL)}" alt="${esc(m.title||'家人寄来的照片')}">`:`<div class="empty"><h2>${m?'一封家书':'还没有照片'}</h2><p>${m?'家人的话，也值得珍藏。':frame?'请家人在手机端寄来第一张照片。':'选一张照片，给家里的相框捎个信。'}</p></div>`;$('#caption').innerHTML=m?`<h2>${esc(m.title||'家人寄来的想念')}</h2><p>${esc(m.editedText||m.text||'')}</p><small>${esc(m.name)} · ${new Date(m.createdAt).toLocaleString('zh-CN')} ${!frame?receiptLabel(m):''}</small>`:'';$('#position').textContent=p.length?`${p.findIndex(x=>x._id===selected)+1} / ${p.length}`:'等待第一张照片';$('#prev').disabled=$('#next').disabled=p.length<2;if(!frame){const el=$('#currentAudio');if(el.dataset.message!==(m?._id||'')){el.querySelector('audio')?.pause();el.replaceChildren();el.dataset.message=m?._id||''}if(m?.audioURL&&!el.querySelector('audio')){const label=document.createElement('small');label.textContent='家人的原声';const audio=document.createElement('audio');audio.controls=true;bindAudio(audio,m);el.append(label,audio)}else if(el.querySelector('audio'))refreshAudio(el.querySelector('audio'))}else{if(frameAudio&&frameAudio.dataset.message!==m?._id){frameAudio.pause();frameAudio=null;$('#listen').textContent='▶ 听原声'}if(frameAudio)refreshAudio(frameAudio);$('#listen').disabled=!m?.audioURL}}
// Signed media URLs rotate. Keep an active stream untouched; adopt the latest URL
// only while paused, at the next play, or after a failed load.
function audioMessage(audio){return state?.messages.find(m=>m._id===audio.dataset.message)}
function refreshAudio(audio,force=false){const url=audioMessage(audio)?.audioURL;if(!url||audio.dataset.url===url||(!force&&!audio.paused&&!audio.ended&&!audio.error&&!audio.dataset.loadFailed))return false;const time=audio.ended?0:audio.currentTime;audio.dataset.url=url;delete audio.dataset.loadFailed;audio.src=url;if(time>0){audio.addEventListener('loadedmetadata',()=>{if(Number.isFinite(audio.duration))audio.currentTime=Math.min(time,audio.duration)},{once:true})}return true}
function bindAudio(audio,message){audio.dataset.message=message._id;audio.dataset.url=message.audioURL;audio.src=message.audioURL;audio.addEventListener('pause',()=>refreshAudio(audio));audio.addEventListener('ended',()=>refreshAudio(audio));audio.addEventListener('play',()=>{if(refreshAudio(audio,true))audio.play().catch(()=>toast('原声未能播放，请再点一次播放'))});audio.addEventListener('loadeddata',()=>{delete audio.dataset.loadFailed});audio.addEventListener('error',()=>{audio.dataset.loadFailed='true';if(refreshAudio(audio,true)){toast('已更新原声地址，请再次播放');return}toast('原声加载失败，正在刷新地址；请稍后再次播放');if(!sessionExpired)poll()});return audio}
function refreshManagedAudio(){document.querySelectorAll('audio[data-message]').forEach(a=>refreshAudio(a));if(frameAudio)refreshAudio(frameAudio)}

function safeLink(url){try{return new URL(url).protocol==='https:'?url:'#'}catch{return '#'}}
// Spatial status is rendered independently of photos, audio and editable forms.
// A state poll never requests an asset or constructs a viewer.
const spatialRequests=new Map(), spatialRequestErrors=new Map();
let spatialView=null;
function eligibleSpatialLink(value){
  return !!globalThis.MemorySpatialLink.parseShare(value)
}
function refreshLinkHint(){
  const hint=$('#spatialLinkHint');if(!hint)return;
  const input=globalThis.MemorySpatialLink.inspect(draft.link);
  hint.textContent=input.hint;
  if(!sending&&$('#send'))$('#send').textContent=input.kind==='share'?'寄出并导入空间':input.url?'寄出来源链接':'寄到相框';
}
function spatialLabel(status){return ({queued:'空间等待导入',importing:'空间导入中',ready:'空间可观看',failed:'空间导入未完成'})[status]||'空间状态待确认'}
function spatialSourceURL(message){const source=message?.spatial?.sourceURL||message?.link;return safeLink(source)==='#'?'':source}
function spatialPanel(message){
  if(!message?.link&&!message?.spatial)return '';
  const spatial=message.spatial, id=message._id, pending=spatialRequests.has(id), status=spatial?.status;
  const source=spatialSourceURL(message), eligible=eligibleSpatialLink(message.link);
  if(!eligible&&!spatial)return source?`<section class="spatial-card" aria-label="空间来源"><p class="spatial-description">${esc(globalThis.MemorySpatialLink.inspect(message.link).hint)}</p><a class="button quiet" href="${esc(source)}" target="_blank" rel="noopener noreferrer">打开原始页面 ↗</a></section>`:'';
  const active=['queued','importing'].includes(status);
  const percentage=typeof spatial?.progress==='number'&&Number.isFinite(spatial.progress)?Math.max(0,Math.min(100,Math.round(spatial.progress))):null;
  const stages={queued:'等待开始',fetching:'正在读取分享页面',resolving:'正在读取分享页面',downloading:'正在下载空间',validating:'正在校验空间',extracting:'正在检查空间内容',storing:'正在保存到家里',saving:'正在保存到家里'};
  const stage=stages[spatial?.stage]||'正在处理空间';
  const awaiting=pending&&!active&&status!=='ready';
  const label=awaiting?'正在提交导入请求':spatial?spatialLabel(status):'空间链接已保存';
  let description=status==='ready'?'点开后才会加载空间，可在家人端和相框端观看。':active?`${status==='queued'?'等待导入':stage}${percentage===null?'':` · ${percentage}%`}。可以继续寄照片和原声。`:status==='failed'?'原链接仍可查看，家人端可以重新导入。':pending?'正在等待服务端状态，可以继续寄照片和原声。':frame?'等待家人在手机端导入，也可先查看影石来源。':'导入后，家人和相框都能在这里观看。';
  const size=Number.isFinite(spatial?.bytes)&&spatial.bytes>0?` · ${(spatial.bytes/1048576).toFixed(1)} MB`:'';
  const action=status==='ready'?`<button class="blue" data-spatial-action="view" data-message="${esc(id)}" ${sessionExpired?'disabled':''}>打开空间</button>`:!frame&&eligible?`<button class="blue" data-spatial-action="import" data-message="${esc(id)}" ${pending||active||sessionExpired?'disabled':''}>${pending||active?'正在导入…':status==='failed'?'重试导入':'导入空间'}</button>`:'';
  if(awaiting)description='正在等待服务端状态，可以继续寄照片和原声。';
  if(sessionExpired)description=frame?'登录已失效，请重新配对后观看空间。':'登录已失效，请重新登录后导入或观看空间。';
  const requestError=status==='ready'?'':spatialRequestErrors.get(id);
  return `<section class="spatial-card" aria-label="空间记忆"><div class="row between"><b>${esc(label)}</b><small>影石来源${size}</small></div>${spatial?.sourceTitle?`<p class="spatial-source-title">${esc(spatial.sourceTitle)}</p>`:''}<p class="spatial-description" role="status">${esc(description)}</p>${active?`<progress max="100" ${percentage===null?'':`value="${percentage}"`} aria-label="空间导入进度"></progress>`:''}${status==='failed'&&!awaiting&&spatial.error?`<p class="error">${esc(stages[spatial.failureStage]?stages[spatial.failureStage]+'时未完成：':'')}${esc(spatial.error)}</p>`:''}${requestError?`<p class="error" role="status">${esc(requestError)}</p>`:''}<div class="row">${action}${source?`<a class="button quiet" href="${esc(source)}" target="_blank" rel="noopener noreferrer">查看影石来源 ↗</a>`:''}</div></section>`;
}
function refreshSpatialPanels(){
  document.querySelectorAll('[data-spatial-message]').forEach(slot=>{
    const message=state?.messages.find(m=>m._id===slot.dataset.spatialMessage), html=spatialPanel(message);
    if(slot._spatialHTML===html)return;
    const focused=slot.contains(document.activeElement)?document.activeElement.dataset.spatialAction:null;
    slot._spatialHTML=html;slot.innerHTML=html;
    if(focused)slot.querySelector(`[data-spatial-action="${focused}"]`)?.focus({preventScroll:true});
  });
  if(spatialView&&!state?.messages.some(m=>m._id===spatialView.id))closeSpatialViewer();
}
async function importSpatial(id){
  if(frame||sessionExpired||spatialRequests.has(id))return;
  const message=state?.messages.find(m=>m._id===id);
  if(!message||!eligibleSpatialLink(message.link)||['queued','importing','ready'].includes(message.spatial?.status))return;
  const token=session?.token, controller=new AbortController();let timedOut=false;
  // Outlast the backend's bounded import, but never leave a half-open request
  // disabling retry forever. A timeout is not evidence of server-side failure.
  const timeout=setTimeout(()=>{timedOut=true;controller.abort()},160000);
  spatialRequests.set(id,controller);spatialRequestErrors.delete(id);refreshSpatialPanels();
  try{
    const result=await api('spatialImport',{id},token,{signal:controller.signal});
    if(session?.token!==token||sessionExpired)return;
    const latest=state?.messages.find(m=>m._id===id);
    if(latest&&result.spatial&&(!latest.spatial||(result.spatial.updatedAt||0)>=(latest.spatial.updatedAt||0)))latest.spatial=result.spatial;
    if(result.spatial?.status==='ready')toast('空间已导入，点“打开空间”即可观看');
    else if(result.spatial?.status==='failed')toast('空间导入未完成，可查看原因后重试');
  }catch(error){
    if((error.name!=='AbortError'||timedOut)&&!sessionExpired&&session?.token===token)spatialRequestErrors.set(id,error.status?error.message:timedOut?'导入请求等待超时，正在核对服务端状态；如显示导入未完成，可重试。':'导入请求连接中断，正在核对服务端状态。状态未更新前请稍候。');
  }finally{
    clearTimeout(timeout);if(spatialRequests.get(id)===controller)spatialRequests.delete(id);
    if(session?.token===token&&!sessionExpired){refreshSpatialPanels();poll()}
  }
}
function closeSpatialViewer(){
  const view=spatialView;spatialView=null;
  if(view){if(typeof reportFramePresence==='function')reportFramePresence(true);view.controller.abort();try{view.handle?.destroy()}catch(error){console.warn('空间查看器释放失败',error.name)}}
  $('#spatialViewport').replaceChildren();
  if($('#spatialDialog').open)$('#spatialDialog').close();
}
function releaseSpatialSession(){
  closeSpatialViewer();for(const controller of spatialRequests.values())controller.abort();spatialRequests.clear();spatialRequestErrors.clear();
}
async function showSpatialViewer(id){
  const message=state?.messages.find(m=>m._id===id);if(!message||message.spatial?.status!=='ready'||sessionExpired)return;
  closeSpatialViewer();
  const view={id,token:session?.token,controller:new AbortController(),handle:null,ready:false};spatialView=view;
  const currentView=()=>spatialView===view&&!view.controller.signal.aborted&&!sessionExpired&&session?.token===view.token;
  const dialog=$('#spatialDialog'),viewport=$('#spatialViewport');
  $('#spatialTitle').textContent=message.spatial.sourceTitle||message.title||'看看这个空间';
  $('#spatialAttribution').textContent='来源：Insta360 / 影石 · 仅供观看已导入空间';
  const source=spatialSourceURL(message);$('#spatialSource').hidden=!source;if(source)$('#spatialSource').href=source;
  const loading=document.createElement('p');loading.className='spatial-loading';loading.textContent='正在准备空间，请稍候…';loading.setAttribute('role','status');viewport.append(loading);
  dialog.showModal();$('#closeSpatial').focus();if(typeof reportFramePresence==='function')reportFramePresence(true);
  const refreshAsset=async()=>{
    if(!currentView())throw new DOMException('空间已关闭','AbortError');
    const result=await api('spatialAsset',{id},view.token,{signal:view.controller.signal});
    if(!currentView())throw new DOMException('空间已关闭','AbortError');
    return result;
  };
  try{
    const asset=await refreshAsset();if(!currentView())return;
    const {openSpatialViewer}=await import('/spatial-viewer.js?v=0.4.1');if(!currentView())return;
    const mount=document.createElement('div');mount.className='spatial-viewer-mount';viewport.replaceChildren(mount);
    // A distinct mount per instance prevents late events from an old renderer
    // marking the replacement as ready. Loading/error screens are not viewing.
    mount.addEventListener('spatial-viewer-state',event=>{
      if(!currentView())return;
      const ready=event.detail?.state==='ready';
      if(view.ready!==ready){view.ready=ready;if(typeof reportFramePresence==='function')reportFramePresence(true)}
    });
    const handle=await openSpatialViewer({container:mount,asset,refreshAsset,onClose:()=>{if(currentView())closeSpatialViewer()},signal:view.controller.signal});
    if(!currentView()){handle?.destroy();return}view.handle=handle;
  }catch(error){
    if(!currentView()||error.name==='AbortError')return;
    if(view.ready){view.ready=false;if(typeof reportFramePresence==='function')reportFramePresence(true)}
    viewport.replaceChildren();const text=document.createElement('p');text.className='error';text.setAttribute('role','alert');text.textContent='空间暂时无法打开：'+error.message;
    const retry=document.createElement('button');retry.className='blue';retry.textContent='重新打开';retry.onclick=()=>showSpatialViewer(id);viewport.append(text,retry);
  }
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-spatial-action]');if(!button||button.disabled)return;if(button.dataset.spatialAction==='import')importSpatial(button.dataset.message);else if(button.dataset.spatialAction==='view')showSpatialViewer(button.dataset.message)});
$('#closeSpatial').onclick=closeSpatialViewer;
$('#spatialDialog').addEventListener('cancel',event=>{event.preventDefault();closeSpatialViewer()});
$('#spatialDialog').addEventListener('close',()=>{if(!$('#spatialDialog').open&&spatialView)closeSpatialViewer()});
window.addEventListener('pagehide',releaseSpatialSession);
function receiptLabel(m){if(m.type==='reply')return '· 已保存到家庭';const r=state.receipts.find(r=>r.message===m._id);return r?.playedAt?'· 相框已听过':r?.deliveredAt?'· 已送达相框':'· 等待相框接收'}
function renderList(force=false){renderFamilyMemories(force)}
function aiLabel(m){if(m.card?.confirmed)return '家人已确认';if(m.card?.source==='ai'&&!m.card.confirmed)return 'AI 整理 · 待家人确认';return ({waiting:'原声已保存 · 等待整理',processing:'正在识别与整理',done:'记忆已整理',failed:'整理未完成，可重试','ready-text':'文字已保存',none:'照片已保存'})[m.aiStatus]||'已保存'}
let stateRequest=null;
let historyRequest=null,historyPage=null,historyStarted=false,historyError='';
function cancelHistory(){const pending=historyRequest;historyRequest=null;pending?.abort()}
function resetHistory(){cancelHistory();stateRequest?.abort();stateRequest=null;historyPage=null;historyStarted=false;historyError=''}
function orderedMemories(messages){return [...new Map(messages.map(message=>[message._id,message])).values()].sort((a,b)=>a.createdAt-b.createdAt||(a._id<b._id?-1:a._id>b._id?1:0))}
function validHistoryPage(page){return page&&typeof page.hasMore==='boolean'&&Number.isSafeInteger(page.total)&&page.total>=0&&(!page.hasMore||typeof page.nextCursor==='string'&&page.nextCursor.length>0)}
function historyStateData(){return !frame&&historyPage?{historyIds:state.messages.map(message=>message._id).slice(0,300)}:{}}
function reconcileHistory(nextState){
  if(frame)return nextState;
  if(!validHistoryPage(nextState.messagePage)){historyPage=null;historyStarted=false;historyError='';return nextState}
  // Every requested old ID is reconciled from the server: omitted IDs were
  // removed or are no longer accessible. Never retain an old media URL locally.
  const historical=Array.isArray(nextState.historyMessages)?nextState.historyMessages:[];
  nextState.messages=orderedMemories([...historical,...nextState.messages]);
  if(!historyStarted||!historyPage)historyPage={...nextState.messagePage};
  else historyPage={...historyPage,total:nextState.messagePage.total};
  // If the window changed while all history was loaded, revisit the current
  // boundary so an insertion or a missed refresh cannot leave a hidden gap.
  if(!historyPage.hasMore&&nextState.messages.length<historyPage.total&&nextState.messagePage.hasMore)historyPage={...nextState.messagePage};
  return nextState;
}
async function loadHistory(){
  if(frame||!session||sessionExpired||authScreenActive||!state||!historyPage?.hasMore||historyRequest)return;
  // Serialize page reads with state refreshes. A poll that began before this
  // page cannot overwrite it; a later edit/remove poll cancels this page.
  clearTimeout(pollTimer);stateRequest?.abort();stateRequest=null;
  const controller=new AbortController(),token=session.token,room=session.room;
  historyRequest=controller;historyError='';renderHistoryControls();
  const currentRequest=()=>historyRequest===controller&&!authScreenActive&&!sessionExpired&&session?.token===token&&session?.room===room;
  const timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const page=await api('history',{cursor:historyPage.nextCursor,limit:50},token,{signal:controller.signal});
    if(!currentRequest())return;if(controller.signal.aborted)throw new DOMException('aborted','AbortError');
    if(!validHistoryPage(page)||!Array.isArray(page.messages))throw new Error('历史记忆暂时无法读取');
    // Loading an old reply is browsing, never a new-message notification.
    if(seenReplies!==null)for(const message of page.messages)if(message.type==='reply')seenReplies.add(message._id);
    state.messages=orderedMemories([...state.messages,...page.messages]);
    historyPage={nextCursor:page.nextCursor,hasMore:page.hasMore,total:page.total};historyStarted=true;
    renderPhoto();renderList(true);refreshManagedAudio();refreshExperience();
  }catch(error){
    if(!currentRequest()||error.status===401)return;
    historyError=error.name==='AbortError'?'加载等待超时，请重试':error.message||'历史记忆加载失败，请重试';
  }finally{
    clearTimeout(timeout);
    if(historyRequest===controller){historyRequest=null;renderHistoryControls();if(!authScreenActive&&!sessionExpired&&session?.token===token&&session?.room===room)poll()}
  }
}
async function poll(){
  clearTimeout(pollTimer);if(!session||sessionExpired||authScreenActive)return;
  cancelHistory();if(!frame)renderHistoryControls();
  stateRequest?.abort();
  const controller=new AbortController();stateRequest=controller;
  const pollToken=session.token,pollStartedAt=performance.now(),timeout=setTimeout(()=>controller.abort(),12000);
  const currentRequest=()=>stateRequest===controller&&!authScreenActive&&!sessionExpired&&session?.token===pollToken;
  try{
    const previousLatest=photos().at(-1)?._id;
    const nextState=await api('state',historyStateData(),pollToken,{signal:controller.signal});if(!currentRequest())return;
    state=reconcileHistory(nextState);globalThis.MemoryAI?.refreshProactive?.();globalThis.MemoryContact?.refresh();stateReceivedAt=performance.now();stateRoundTripMs=Math.max(0,stateReceivedAt-pollStartedAt);syncFrameSelection();refreshManagedAudio();
    const latest=photos().at(-1)?._id;
    if(latest&&latest!==previousLatest&&(frame||!followFrame)&&!recording&&!draft.audio&&!(frameAudio&&!frameAudio.paused)&&![...document.querySelectorAll('audio')].some(a=>!a.paused))selected=latest;
    failures=0;$('#connection').textContent='● 已连接';$('#syncError').hidden=true;$('#roomName').textContent=state.room.name;
    $('#members').textContent=state.members.map(m=>`${m.name} ${m.online?'在线':'离线'}`).join(' · ');
    renderPhoto();renderList();refreshProcessingButton();refreshSpatialPanels();refreshExperience();reportFramePresence();globalThis.MemoryPresence?.receive(state.presenceEvent);
    if(frame){for(const m of photos().filter(m=>!state.receipts.some(r=>r.message===m._id)).slice(-10))await api('receipt',{id:m._id},pollToken,{signal:controller.signal})}
  }catch(error){
    if(error.status===401||!currentRequest())return;
    failures++;$('#connection').textContent='○ 连接中断';if(!frame&&$('#framePresence'))renderFramePresence();
    const el=$('#syncError');if(el){el.hidden=false;el.textContent=(error.name==='AbortError'?'同步等待超时':error.message)+'，将自动重试。';const btn=document.createElement('button');btn.textContent='立即重试';btn.onclick=poll;el.append(btn)}
  }finally{
    clearTimeout(timeout);
    if(currentRequest())pollTimer=setTimeout(poll,Math.min(30000,(document.hidden?15000:3000)*Math.max(1,failures)));
    if(stateRequest===controller)stateRequest=null;
  }
}
let frameAudio;
async function listen(){const m=current();if(!m?.audioURL)return;if(frameAudio&&frameAudio.dataset.message!==m._id){frameAudio.pause();frameAudio=null}if(frameAudio&&!frameAudio.paused){frameAudio.pause();$('#listen').textContent='▶ 听原声';reportFramePresence(true);return}if(!frameAudio){frameAudio=bindAudio(new Audio(),m);frameAudio.onended=()=>{if($('#listen'))$('#listen').textContent='▶ 听原声'};frameAudio.addEventListener('pause',()=>{if($('#listen'))$('#listen').textContent='▶ 听原声';reportFramePresence(true)})}refreshAudio(frameAudio);try{await frameAudio.play();$('#listen').textContent='Ⅱ 暂停原声';reportFramePresence(true);await api('receipt',{id:m._id,played:true})}catch(e){if(e.name!=='AbortError')toast(e.message)}}
function updateClock(){if($('#clock'))$('#clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});applyLocalDisplay();setTimeout(updateClock,30000)}
function activeProcessing(m){return m?.aiStatus==='processing'&&(!Number.isFinite(m.aiLeaseUntil)||m.aiLeaseUntil>(state?.serverTime||Date.now()))}
function refreshProcessingButton(){const button=$('#process');if(!button)return;const m=state?.messages.find(m=>m._id===button.dataset.message);if(!m)return;button.hidden=m.aiStatus==='done'||!!m.card?.confirmed;button.disabled=activeProcessing(m);button.textContent=activeProcessing(m)?'正在处理…':['failed','processing'].includes(m.aiStatus)?'重试处理':'整理记忆'}
async function processMemory(id){const existing=state?.messages.find(m=>m._id===id);if(existing?.aiStatus==='done'||existing?.card?.confirmed)return toast('这份记忆已完成整理');if(activeProcessing(existing))return toast('正在处理，请稍候');toast('正在提交记忆处理请求');try{const result=await api('process',{id});if(result.state==='already-done')toast('这份记忆已完成整理');else if(result.state==='processing')toast('正在处理，请稍候');else if(result.retryAfterMs)toast('处理服务繁忙，稍后可重试');await poll();const m=state?.messages.find(m=>m._id===id);if(m?.aiStatus==='failed')toast(m.aiError||'整理失败，可以手工补充或重试')}catch(e){toast(e.message)}}
function detail(id){const m=state.messages.find(m=>m._id===id);if(!m)return;modal(`<h2>${esc(m.title||m.card?.title||'一份家里的记忆')}</h2>${m.imageURL?`<img class="detail-photo" src="${esc(m.imageURL)}" alt="记忆照片">`:''}${m.audioURL?`<p>家人的原声 · ${m.duration} 秒</p><audio controls src="${esc(m.audioURL)}"></audio>`:'<p class="muted">这份记忆没有原声录音。</p>'}<div data-spatial-message="${esc(id)}"></div>${memoryReadingHTML(m)}<p class="status">${esc(aiLabel(m))}</p>${m.aiError?`<p class="error">${esc(m.aiError)}</p>`:''}<details><summary>查看原始文字 / 转写</summary><p>${esc(m.transcription||m.text||'尚无转写内容')}</p></details><div id="relatedMemories"></div><h3>家人补充与修订</h3><form id="editForm" class="form"><label>记忆标题<input name="title" maxlength="20" value="${esc(m.title||m.card?.title)}"></label><label>修订文字<textarea name="text">${esc(m.editedText||m.transcription||m.text)}</textarea></label><label>记忆摘要<textarea name="summary" maxlength="120">${esc(m.card?.summary)}</textarea></label><label>人物（用逗号分开）<input name="people" value="${esc(m.card?.people?.join('，'))}"></label><div class="row"><label>年份<input name="year" value="${esc(m.card?.year)}"></label><label>地点<input name="place" value="${esc(m.card?.place)}"></label></div><button class="primary">保存修订</button></form><div class="row actions">${m.aiStatus!=='done'&&!m.card?.confirmed?`<button id="process" data-message="${esc(id)}" class="quiet" ${activeProcessing(m)?'disabled':''}>${activeProcessing(m)?'正在处理…':['failed','processing'].includes(m.aiStatus)?'重试处理':'整理记忆'}</button>`:''}<button id="copyMemory" class="quiet">复制记忆文字</button><button id="remove" class="danger">移出记忆列表</button></div>`);refreshSpatialPanels();bindMemoryReading(m);globalThis.MemoryAI?.addMemoryEntry(m);const detailAudio=$('#modalBody audio');if(detailAudio)bindAudio(detailAudio,m);$('#editForm').onsubmit=async e=>{e.preventDefault();try{const d=Object.fromEntries(new FormData(e.target));d.people=d.people.split(/[,，]/).map(s=>s.trim()).filter(Boolean);await api('edit',{id,...d});$('#modal').close();toast('修订已保存');poll()}catch(e){toast(e.message)}};if($('#process'))$('#process').onclick=()=>{processMemory(id);$('#modal').close()};$('#remove').onclick=async()=>{if(!confirm('将这份记忆移出列表？'))return;try{await api('remove',{id});$('#modal').close();poll()}catch(e){toast(e.message)}}}
async function inviteDialog(){modal('<h2>把家人连在一起</h2><p>选择邀请方式，链接 24 小时内有效。</p><div class="row"><button id="familyInvite" class="primary">邀请家人</button><button id="frameInvite" class="blue">配对相框</button></div><div id="inviteResult"></div>');const generate=async role=>{try{const data=await api('invite',{role});const separator=location.hostname.endsWith('.service.tcloudbase.com')?'?':'#';const url=location.origin+'/'+(role==='frame'?'frame':'family')+separator+'invite='+data.invite;$('#inviteResult').innerHTML=`<img class="qr" alt="扫描邀请二维码" src="/qr.svg?text=${encodeURIComponent(url)}"><p class="muted">${role==='frame'?'在相框的浏览器打开此链接完成配对。':'请家人在手机上打开此链接加入。'}</p><p class="invite-link">${esc(url)}</p><label>邀请码（24 小时内有效）<input class="invite-code" readonly value="${esc(data.invite)}" aria-label="邀请码"></label><p class="muted">首次访问先点平台的“确定访问”；若未自动填入，可粘贴完整链接或邀请码。</p><div class="row"><button id="copyCode" class="quiet">复制邀请码</button><button id="copyInvite" class="primary">复制链接</button><button id="shareInvite" class="blue">分享邀请</button></div>`;$('#copyCode').onclick=async()=>{try{await navigator.clipboard.writeText(data.invite);toast('邀请码已复制')}catch{prompt('复制邀请码',data.invite)}};$('#copyInvite').onclick=async()=>{try{await navigator.clipboard.writeText(url);toast('邀请链接已复制')}catch{prompt('复制邀请链接',url)}};$('#shareInvite').onclick=async()=>{try{if(navigator.share)await navigator.share({title:'加入 unseen 记忆相框',url});else await navigator.clipboard.writeText(url)}catch(e){if(e.name!=='AbortError')toast('请使用复制链接分享')}}}catch(e){toast(e.message)}};$('#familyInvite').onclick=()=>generate('family');$('#frameInvite').onclick=()=>generate('frame')}
function peopleDialog(){modal(`<h2>记忆里的人</h2><p>${state.people.map(p=>esc(p.name)+'（'+esc(p.relation||'家人')+'）').join('、')||'还没有人物，添加你们自己的家人称呼。'}</p><form id="personForm" class="form"><label>称呼<input name="name" required maxlength="30"></label><label>关系<input name="relation" maxlength="40" placeholder="例如：我的妈妈"></label><button class="primary">保存人物</button></form>`);$('#personForm').onsubmit=async e=>{e.preventDefault();try{await api('person',Object.fromEntries(new FormData(e.target)));$('#modal').close();poll()}catch(e){toast(e.message)}}}
$('#settings').onclick=()=>{
  modal(`<h2>unseen 记忆相框</h2><h3>家庭与设备</h3><p>当前身份：${esc(session.name)} · ${frame?'相框端':'家人端'}</p>${session.username?`<p>家人账号：<b>${esc(session.username)}</b></p>`:''}<div>${state?.members.map(m=>`<div class="device row between"><span>${esc(m.name)} <small>${m.online?'在线':'离线'} · ${m.role==='frame'?'相框':m.username?'账号 '+esc(m.username):'家人设备'}</small></span>${session.role==='owner'?`<button class="quiet revoke" data-id="${esc(m.id)}">${m.username?'移除账号':'移除设备'}</button>`:''}</div>`).join('')||''}</div>${session.role==='owner'?'<p class="muted">移除家人账号会让该账号的所有设备退出，并停止该账号再次登录。相框或免账号设备只移除所选设备。</p>':''}<p class="muted">在线表示设备最近 45 秒有连接。原声由真实麦克风录制；AI 整理需要服务端配置。草稿仅保存在当前浏览器。</p><button id="logout" class="quiet">${frame?'退出配对':session.username?'退出账号':'退出当前设备'}</button>`);
  addDisplaySettings();globalThis.MemoryPresenceSettings?.mount();$('#logout').onclick=logoutSession;
  document.querySelectorAll('.revoke').forEach(button=>button.onclick=async()=>{
    const member=state?.members.find(item=>item.id===button.dataset.id);
    const message=member?.username?`移除家人账号 ${member.username}？该账号的所有设备都会退出，之后也无法再登录。家里已有的记忆会保留。`:'移除该设备的访问权限？';
    if(!confirm(message))return;
    button.disabled=true;
    try{await api('revoke',{id:button.dataset.id});$('#modal').close();poll()}catch(error){toast(error.message)}finally{if(button.isConnected)button.disabled=false}
  });
};
window.addEventListener('online',()=>session&&poll());document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelRecordingStart();else if(session)poll()});window.addEventListener('pagehide',cancelRecordingStart);window.addEventListener('beforeunload',e=>{if(recording){e.preventDefault();e.returnValue='录音尚未结束'}});
(async()=>{try{db=await database();await loadDraft()}catch{toast('浏览器不允许保存草稿，请保持页面打开')}if(session&&!invite){shell();poll()}else authScreen()})();

function mountFrameMenu(){
 let menu=$('#frameMenu');if(!menu){menu=document.createElement('details');menu.id='frameMenu';menu.innerHTML='<summary>更多</summary><div class="frame-menu-items"></div>';$('#settings').before(menu)}
 for(const id of ['openAI','openContact','settings']){const control=$('#'+id);if(control)menu.lastElementChild.append(control)}
 menu.hidden=false;menu.onclick=event=>{if(event.target.closest('button'))menu.open=false};
}
