'use strict';
// Account secrets live only in the submitted form and request, never in drafts,
// session storage or links. Existing room-based drafts keep their original keys.
function authScreen({resume=false}={}){
  authScreenActive=true;applyLocalDisplay();clearTimeout(pollTimer);clearTimeout(presenceExpiryTimer);
  seenReplies=null;$('#settings').hidden=true;$('#connection').textContent=frame?'待配对相框':'请登录家人账号';app.className='';
  let mode=frame?'pair':invite&&!resume?'register':'login',familyMode='join',pending=false;
  const remembered={username:'',nickname:'',name:'',invite:resume?'':invite};
  app.innerHTML=`<section class="paper taped welcome"><p class="auth-brand">unseen 记忆相框 · ${frame?'相框设备':'家人端'}</p><h1>${frame?'让想念，在这里相见':'把日子，寄给想念的人'}</h1><p class="muted">${frame?'在家人手机上生成相框配对链接，打开后即可接收照片与原声。相框设备不需要注册家人账号。':'照片、一句话，还有熟悉的声音。登录后回到自己的家庭，继续留下家里的记忆。'}</p>${frame?'':`<div class="row tabs auth-tabs" role="tablist" aria-label="家人账号"><button type="button" id="loginTab" role="tab">登录账号</button><button type="button" id="registerTab" role="tab">注册账号</button></div>`}<form id="authForm" class="form" aria-describedby="authError"></form><p id="authError" class="error" role="alert" hidden></p>${frame?'':`<button type="button" id="legacyAuth" class="auth-legacy quiet">使用原有邀请方式（免账号）</button>`}<p class="muted auth-endpoint">${frame?'<a href="/family">打开家人端，注册或登录账号</a>':'相框设备请打开 <a href="/frame">相框端</a>，用配对链接连接。'}</p></section>`;
  const remember=()=>{for(const input of $('#authForm').querySelectorAll('input'))if(Object.hasOwn(remembered,input.name))remembered[input.name]=input.value};
  const error=message=>{const el=$('#authError');el.hidden=!message;el.textContent=message||''};
  const usernameField=()=>`<label>账号<input name="username" value="${esc(remembered.username)}" required minlength="3" maxlength="32" pattern="[A-Za-z0-9._\\-]{3,32}" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="例如：family01" aria-describedby="usernameHint"></label><small id="usernameHint">3–32 位字母、数字、点、下划线或短横线，不区分大小写。</small>`;
  const nicknameField=()=>`<label>${frame?'相框称呼':'你的称呼'}<input name="nickname" value="${esc(remembered.nickname)}" required maxlength="30" autocomplete="nickname" placeholder="${frame?'客厅的相框':'家人怎么称呼你'}"></label>`;
  const inviteField=(required=true)=>`<label>${frame?'配对':'家庭邀请'}链接或邀请码${required?'':'（可选）'}<input name="invite" value="${esc(remembered.invite)}" ${required?'required':''} autocomplete="off" spellcheck="false" placeholder="粘贴完整邀请链接或邀请码"></label>`;
  const show=()=>{
    const account=mode==='login'||mode==='register',register=mode==='register';
    if(!frame){for(const tab of ['login','register']){const active=mode===tab;$('#'+tab+'Tab').setAttribute('aria-selected',String(active));$('#'+tab+'Tab').className=active?'blue':'quiet'}$('#legacyAuth').textContent=mode==='legacy'?'返回账号登录':'使用原有邀请方式（免账号）'}
    let fields='';
    if(account){fields=usernameField()+`<label>密码<input type="password" name="password" required minlength="8" maxlength="128" autocomplete="${register?'new-password':'current-password'}" placeholder="${register?'设置 8–128 位密码':'输入账号密码'}"></label>`}
    if(mode==='login'){
      if(remembered.invite)fields+=`<p class="auth-invite-note">已带入家庭邀请。已有此家庭的账号可直接登录；其他家人请注册加入。</p>${inviteField(false)}<small>如果只想回到账号原来的家庭，可清空邀请后登录。</small>`;
      fields+='<button type="submit" class="primary">登录，回到我的家</button><small>账号登录无需重新索取邀请。原有免账号草稿仍保留在原入口，各账号的草稿分别保存。</small><small>当前尚无自助找回密码；忘记密码请联系部署者。</small>';
    }else{
      fields+=nicknameField();
      if(!frame)fields+=`<fieldset class="auth-family-mode"><legend>${register?'注册后要加入哪个家庭？':'选择家庭入口'}</legend><div class="row"><label><input type="radio" name="mode" value="join" ${familyMode==='join'?'checked':''}>加入已有家庭</label><label><input type="radio" name="mode" value="create" ${familyMode==='create'?'checked':''}>创建新家庭</label></div></fieldset>`;
      fields+=`<div id="familyAccess" class="form"></div><button type="submit" class="primary">${frame?'完成配对':register?'注册并加入家庭':'加入家庭'}</button>${!frame?`<small>${register?'每个账号对应一个家庭。账号注册成功后，下次直接用账号密码登录。':'免账号方式仍可使用。退出或设备失效后，需要有效邀请再次加入。'}</small>`:''}`;
    }
    $('#authForm').innerHTML=fields;error('');
    if(mode!=='login'){
      showAccess();
      for(const radio of $('#authForm').querySelectorAll('input[name="mode"]'))radio.onchange=()=>{remember();familyMode=radio.value;showAccess();error('')};
    }
  };
  const showAccess=()=>{
    $('#familyAccess').innerHTML=!frame&&familyMode==='create'?`<label>家庭名称<input name="name" value="${esc(remembered.name)}" required maxlength="40" placeholder="我们的家"></label><label>开通码<input name="setupCode" required autocomplete="off" placeholder="由部署者提供"></label>`:inviteField()+`<small>${frame?'请使用相框配对邀请，家人邀请不能用于相框。':'请向家庭创建者索取家人邀请；相框配对邀请不能用于注册。'}首次访问如出现平台提示，请先确定访问。</small>`;
    $('#authForm button[type="submit"]').textContent=frame?'完成配对':mode==='register'?(familyMode==='create'?'注册并创建家庭':'注册并加入家庭'):(familyMode==='create'?'创建家庭':'加入家庭');
  };
  if(!frame){for(const tab of ['login','register'])$('#'+tab+'Tab').onclick=()=>{if(pending)return;remember();mode=tab;show()};$('#legacyAuth').onclick=()=>{if(pending)return;remember();mode=mode==='legacy'?'login':'legacy';show()}}
  show();
  $('#authForm').onsubmit=async event=>{
    event.preventDefault();if(pending)return;
    const form=event.currentTarget;if(!form.reportValidity())return;
    const data=Object.fromEntries(new FormData(form));if(data.username)data.username=data.username.trim();if(data.invite)data.invite=parseInvite(data.invite);else delete data.invite;
    const action=mode==='pair'?'join':mode==='legacy'?familyMode:mode;
    const controls=[...app.querySelectorAll('input,button')],button=form.querySelector('button[type="submit"]'),label=button.textContent;
    remember();error('');pending=true;controls.forEach(control=>control.disabled=true);button.textContent=mode==='login'?'正在登录…':'正在连接家庭…';
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
    try{
      const result=await api(action,data,null,{signal:controller.signal});
      if(!result.token||!result.room||!['owner','family','frame'].includes(result.role))throw new Error('登录响应不完整，请稍后重试');
      if((result.role==='frame')!==frame)throw new Error(frame?'这是家人邀请，请在家人端打开':'这是相框配对链接，请在相框端打开');
      // Keep only the server-issued identity. Never copy credentials into session.
      session={token:result.token,room:result.room,role:result.role,name:result.name,...(result.username?{username:result.username}:{})};sessionExpired=false;
      $('#rejoinSession')?.remove();let persistent=true;
      try{localStorage.setItem(key,JSON.stringify(session))}catch{persistent=false}
      draft={};const notices=[];
      try{await loadDraft()}catch{notices.push('未能读取本机草稿，原草稿未删除')}
      shell();poll();
      if(!persistent)notices.push('浏览器未允许保存登录，关闭页面后需要重新登录');
      if(notices.length)toast(notices.join('；'));
    }catch(err){
      if(form.isConnected){error(err.name==='AbortError'?(action==='register'?'请求等待超时。注册可能已成功，请先用刚才的账号密码登录；若尚未注册，再重试。':'请求等待超时，请检查网络后重试。'):err.message)}
    }finally{
      clearTimeout(timeout);delete data.password;delete data.setupCode;pending=false;
      if(form.isConnected){controls.forEach(control=>control.disabled=false);button.textContent=label;if(!$('#authError').hidden)(form.querySelector('input[name="password"]')||button).focus()}
    }
  };
}

async function logoutSession(){
  globalThis.MemoryCall?.dispose();globalThis.MemoryFramePresentation?.exit();
  if(sending)return toast('正在寄出记忆，请等待完成后再退出');
  if(recording)return toast('请先结束录音，保存草稿后再退出');
  const button=$('#logout');if(button?.disabled)return;if(button)button.disabled=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    await saveDraft();
    if(!sessionExpired){try{await api('logout',{},session?.token,{signal:controller.signal})}catch(error){if(error.status!==401)throw error}}
    await rejoinSession({save:false});
  }catch(error){toast((error.name==='AbortError'?'退出请求等待超时':error.message)+'；尚未确认退出，请稍后重试')}finally{clearTimeout(timeout);if(button?.isConnected)button.disabled=false}
}
