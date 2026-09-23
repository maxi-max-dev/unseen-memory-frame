'use strict';
globalThis.MemoryActionUI = (() => {
  let host, token, draft, candidate, members = [], generation = 0, control, voiceURL = '', sending = false, pendingCall = null;
  const el = id => host?.querySelector('#' + id);
  const live = version => version === generation && host?.isConnected && session?.token === token && !sessionExpired;
  function releaseAudio() { host?.querySelectorAll('audio').forEach(a => a.pause()); if (voiceURL) URL.revokeObjectURL(voiceURL); voiceURL = ''; }
  function cancelPendingCall() {
    const pending = pendingCall; pendingCall = null;
    if (pending) globalThis.MemoryCall.cancelStart(pending.requestId, pending.token);
  }
  function dispose() {
    cancelPendingCall();
    generation++; control?.abort(); releaseAudio();
    if (candidate && !sending && ['ready', 'draft'].includes(candidate.status)) api('aiActionCancel', { actionId: candidate.actionId, version: candidate.version }, token).catch(() => {});
    host?.replaceChildren(); host = null; candidate = null; draft = null; sending = false;
  }
  async function call(action, data) {
    const pending = new AbortController(); control = pending; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; pending.abort(); }, 65000);
    try { return await api(action, data, token, { signal: pending.signal }); }
    catch (e) { if (timedOut) throw Error('等待结果超时，执行结果尚未确定'); throw e; }
    finally { clearTimeout(timer); }
  }
  function note(text) { if (el('actionStatus')) el('actionStatus').textContent = text; }
  function previewMedia(parent, ids, audio) {
    const photos = document.createElement('div'); photos.className = 'ai-photos';
    for (const id of ids) { const memory = state?.messages.find(m => m._id === id), img = document.createElement('img'); if (memory?.imageURL) { img.src = memory.imageURL; img.alt = memory.title || '待发送照片'; photos.append(img); } }
    parent.append(photos);
    if (audio && draft.voice) { const player = document.createElement('audio'); player.controls = true; voiceURL ||= URL.createObjectURL(draft.voice); player.src = voiceURL; player.setAttribute('aria-label', '待发送原声，请试听'); parent.append(player); }
  }
  async function suggest({ container, suggestion, messageIds, voice, token: auth }) {
    dispose(); host = container; token = auth; draft = { kind: suggestion.kind, text: suggestion.text, targetHint: suggestion.targetHint, messageIds: suggestion.usePhotos ? [...messageIds] : [], availablePhotos: [...messageIds], voice, useVoice: suggestion.useVoice, usePhotos: suggestion.usePhotos, mode: '' };
    const version = generation;
    host.innerHTML = '<section class="ai-action-card"><h3>行动建议 · 尚未执行</h3><p id="actionStatus" role="status">正在读取真实家庭成员…</p></section>';
    try { const result = await call('contactState', {}); if (!live(version)) return; members = result.members;
      if (draft.kind === 'contact') {
        if (!globalThis.MemoryCall) {
          host.innerHTML = '<section class="ai-action-card"><h3>可以改发联系提醒</h3><p>当前 Demo 不提供实时语音通话。可以准备一条站内提醒，请家人联系你；对方打开相框页面后才能看到。请先选择是否使用提醒，再检查收件人并确认发送。</p><button id="actionChooseReminder" type="button">准备联系提醒</button><button id="actionCancel" type="button">取消</button><p id="actionStatus" role="status"></p></section>';
          el('actionChooseReminder').onclick = () => { draft.mode = 'request-only'; renderForm(); };
          el('actionCancel').onclick = dispose;
          return;
        }
        const available = await call('callCapabilities', {}); if (!live(version)) return;
        host.innerHTML = '<section class="ai-action-card"><h3>选择本次联系的方式</h3><p id="actionCallAvailability"></p><button id="actionChooseCall" type="button">选择语音呼叫</button><p>也可以改发站内联系提醒。对方打开相框页面后才能看到提醒；确认收到不表示音频接通。不会自动替你改变联系方式。</p><button id="actionChooseReminder" type="button">改用联系提醒</button><button id="actionCancel" type="button">取消</button><p id="actionStatus" role="status"></p></section>';
        const supported = Boolean(globalThis.MemoryCall?.supported?.());
        el('actionCallAvailability').textContent = !supported ? '此浏览器不支持语音呼叫；请用 HTTPS 页面及支持 WebRTC 的浏览器。' : available.audioCall ? '语音呼叫已配置。确认后向家人发起呼叫，双方麦克风和网络连接仍需实际成功。' : available.reason || '语音呼叫尚未配置，目前不能拨通。';
        el('actionChooseCall').disabled = !available.audioCall || !supported;
        el('actionChooseCall').onclick = () => { draft.mode = 'audio-call'; renderForm(); };
        el('actionChooseReminder').onclick = () => { draft.mode = 'request-only'; renderForm(); }; el('actionCancel').onclick = dispose;
      } else renderForm();
    } catch (e) { if (live(version)) note(e.message); }
  }
  function renderForm() {
    releaseAudio();
    host.innerHTML = '<section class="ai-action-card"><h3>补充并检查行动内容</h3><p id="actionHint"></p><label>收件人<select id="actionRecipient"><option value="">请选择真实家庭成员</option></select></label><div id="actionMessageFields"><label>留言文字<textarea id="actionText" maxlength="2000" rows="3"></textarea></label><label><input id="actionUsePhotos" type="checkbox">附上选定照片</label><div id="actionPhotoChoices"></div><label><input id="actionVoice" type="checkbox">附上本次原声</label><div id="actionAudioPreview"></div></div><p id="actionScope"></p><button id="actionPrepare" type="button">检查确认卡片</button><button id="actionCancel" type="button">取消</button><p id="actionStatus" role="status"></p></section>';
    el('actionHint').textContent = draft.targetHint ? `你提到“${draft.targetHint}”。请从真实成员中选择；照片人物标签不会自动匹配联系人。` : '请明确选择收件人。';
    for (const member of members) { const option = document.createElement('option'); option.value = member.id; option.textContent = `${member.name} · ${member.role === 'frame' ? '相框' : '家人'} · ${member.id.slice(-6)}`; el('actionRecipient').append(option); }
    el('actionRecipient').value = draft.targetId || ''; el('actionText').value = draft.text;
    el('actionMessageFields').hidden = draft.kind !== 'message'; el('actionUsePhotos').checked = draft.usePhotos;
    for (const id of draft.availablePhotos) { const memory = state?.messages.find(m => m._id === id), label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = id; checkbox.checked = draft.messageIds.includes(id); label.append(checkbox, document.createTextNode(memory?.title || '家庭照片')); el('actionPhotoChoices').append(label); previewMedia(label, [id], false); }
    el('actionVoice').checked = draft.useVoice && Boolean(draft.voice); el('actionVoice').disabled = !draft.voice;
    if (draft.voice) previewMedia(el('actionAudioPreview'), [], true);
    if (draft.useVoice && !draft.voice) note('还没有本次原声。请先录音，再让 AI 帮你准备原声留言。');
    el('actionScope').textContent = draft.kind === 'message' ? '这是给所选家人的共享留言：家庭成员均可见，照片和原声也会进入家庭记忆流。' : draft.mode === 'audio-call' ? '方式：浏览器语音呼叫。确认后响铃，对方主动接听后双方才申请麦克风；仅双方参与，通话不录制保存。' : '方式：站内联系提醒。不会拨打电话，不传输通话音频；仅双方可见。';
    el('actionCancel').onclick = dispose;
    el('actionPrepare').onclick = prepare;
  }
  async function prepare() {
    const version = generation, button = el('actionPrepare'); if (button.disabled) return;
    const targetId = el('actionRecipient').value, includePhotos = el('actionUsePhotos').checked;
    const messageIds = includePhotos ? [...el('actionPhotoChoices').querySelectorAll('input:checked')].map(x => x.value) : [];
    if (!targetId) return note('请选择真实家庭成员；含糊称呼不能直接发送。');
    if (draft.kind === 'message' && includePhotos && !messageIds.length) return note('还未选择要发送的照片。请先在聊天中添加照片，再重新准备。');
    if (draft.kind === 'message' && el('actionVoice').checked && !draft.voice) return note('缺少原声，请先录音。');
    draft = { ...draft, targetId, text: el('actionText').value, messageIds, useVoice: el('actionVoice').checked, usePhotos: includePhotos };
    button.disabled = true; note('正在校验内容，尚未发送…');
    try {
      let audioId = '';
      if (draft.kind === 'message' && draft.useVoice) { const encoded = await base64(draft.voice); if (!live(version)) return; audioId = (await call('upload', { base64: encoded })).id; if (!live(version)) return; }
      const result = await call('aiActionPrepare', { ...(candidate ? { actionId: candidate.actionId, version: candidate.version } : {}), kind: draft.kind, targetId, text: draft.kind === 'message' ? draft.text : '', messageIds: draft.kind === 'message' ? messageIds : [], audioId, ...(draft.mode ? { mode: draft.mode } : {}) });
      if (!live(version)) return; candidate = result; renderCard();
    } catch (e) { if (live(version)) note(e.message); }
    finally { if (live(version) && button.isConnected) button.disabled = false; }
  }
  function renderCard() {
    releaseAudio();
    host.innerHTML = '<section class="ai-action-card"><h3>请确认本次行动</h3><p id="actionRecipientPreview"></p><p id="actionScope"></p><p id="actionTextPreview"></p><div id="actionMediaPreview"></div><p id="actionVersion"></p><div class="row"><button id="actionConfirm" class="primary" type="button"></button><button id="actionModify" type="button">修改</button><button id="actionCancel" type="button">取消</button></div><p id="actionStatus" role="status"></p></section>';
    const recipient = members.find(member => member.id === candidate.targetId);
    el('actionRecipientPreview').textContent = '收件人：' + candidate.targetName + ' · ' + (recipient?.role === 'frame' ? '相框' : '家人') + ' · ' + candidate.targetId.slice(-6);
    el('actionRecipientPreview').setAttribute('title', candidate.targetId);
    el('actionScope').textContent = candidate.kind === 'message' ? '家庭成员均可见。这是家庭共享留言，不是私信。' : candidate.mode === 'audio-call' ? '方式：浏览器语音呼叫。仅双方参与；对方接听后才连接麦克风音频，连接成功前不算接通。不录制保存通话。' : '方式：站内联系提醒。仅双方可见，不拨号，也不传输通话音频。';
    el('actionTextPreview').textContent = candidate.text || (candidate.kind === 'contact' ? candidate.mode === 'audio-call' ? '向这位家人发起语音呼叫。' : '提醒这位家人联系我。' : '没有文字留言。');
    previewMedia(el('actionMediaPreview'), candidate.messageIds, Boolean(candidate.audioId));
    el('actionVersion').textContent = `本次确认版本 ${candidate.version}，${new Date(candidate.expiresAt).toLocaleTimeString('zh-CN')} 前有效。`;
    el('actionConfirm').textContent = candidate.kind === 'message' ? '确认发送共享留言' : candidate.mode === 'audio-call' ? '确认呼叫这位家人' : '确认发送联系提醒';
    el('actionConfirm').disabled = candidate.needs.length > 0 || !['ready', 'failed', 'processing'].includes(candidate.status);
    el('actionModify').textContent = candidate.started ? '查询结果' : '修改 / 查询结果';
    if (candidate.status === 'completed') el('actionModify').disabled = true;
    if (candidate.started || candidate.status === 'completed') el('actionCancel').textContent = '收起';
    if (candidate.needs.length) note('还缺少收件人或内容，请修改后再确认。');
    el('actionCancel').onclick = dispose; el('actionModify').onclick = modify; el('actionConfirm').onclick = confirm;
  }
  async function modify() {
    if (sending) return; const version = generation; el('actionModify').disabled = true; el('actionConfirm').disabled = true;
    try {
      // Read durable state first: a lost confirmation response may already have
      // sent content. Never turn an uncertain execution into a fresh action.
      const result = await call('aiActionGet', { actionId: candidate.actionId });
      if (!live(version)) return; candidate = result;
      if (result.status === 'completed') {
        renderCard(); note(`这项行动已完成，共完成 ${result.completed} 项。不会再次执行；请查看家庭记忆或联系记录。`); return;
      }
      if (result.started || result.completed > 0 || result.results?.length || ['processing', 'failed'].includes(result.status)) {
        renderCard(); note(result.status === 'expired' || result.status === 'cancelled'
          ? '这项行动曾开始执行，现已过期或停止。已经发送的内容不会撤回，请查看记录；不能作为新留言重复发送。'
          : '这项行动已开始执行，内容不能修改。可重试同一确认继续未完成内容，或查询结果；不会重复发送。'); return;
      }
      // Cancel the old version without revalidating its now-missing recipient
      // or media, then prepare an independently reviewed replacement.
      if (result.status !== 'cancelled') {
        const cancelled = await call('aiActionCancel', { actionId: result.actionId, version: result.version });
        if (!live(version)) return; candidate = cancelled;
      }
      // A delayed confirmation may have acquired its lease and sent content
      // after Get. Only the latest atomic cancellation can prove edits are safe.
      if (candidate.started || candidate.completed > 0 || candidate.results?.length) {
        renderCard(); note('这项行动在取消前已开始执行，现已停止后续操作。已有结果保留在原行动中；不能作为新留言重复发送，请查询或查看记录。'); return;
      }
      if (candidate.status !== 'cancelled') {
        renderCard(); note('尚未确认旧行动已取消，请保留原行动并查询结果。'); return;
      }
      const current = await call('contactState', {}); if (!live(version)) return;
      members = current.members;
      if (!members.some(member => member.id === draft.targetId)) draft.targetId = '';
      cancelPendingCall(); candidate = null; renderForm();
    } catch (e) { if (live(version)) {
      renderCard(); note(e.message + '；结果尚未确定，保留原行动。请查询结果或重试同一确认，不会创建新行动。');
    } }
  }
  async function confirm() {
    if (sending || !candidate) return; const version = generation; sending = true;
    if (candidate.mode === 'audio-call' && !globalThis.MemoryCall?.supported?.()) { sending = false; return note('此浏览器无法发起语音呼叫，请更换支持 WebRTC 的浏览器。'); }
    if (candidate.mode === 'audio-call' && recording) { sending = false; return note('请先结束正在录给家人的原声，再确认呼叫。'); }
    if (candidate.mode === 'audio-call') {
      if (document.hidden) { sending = false; return note('请回到页面后再明确确认呼叫。'); }
      if (!candidate.callRequestId || !globalThis.MemoryCall?.cancelStart) { sending = false; return note('呼叫取消能力尚未就绪，请刷新页面后重新准备。'); }
      if (!globalThis.MemoryCall.canStart?.(token)) { sending = false; return note('上次呼叫的结束仍待服务器确认，请恢复连接后再呼叫。'); }
      // Retain the server-issued stable identity before starting the request.
      // Closing/hiding can cancel durably even if fetch abort loses its result.
      pendingCall = { requestId: candidate.callRequestId, token };
    }
    for (const button of host.querySelectorAll('button')) button.disabled = true; note('正在执行已确认的行动…');
    try {
      const result = await call('aiActionConfirm', { actionId: candidate.actionId, version: candidate.version });
      if (!live(version)) return;
      if (pendingCall && document.hidden) { dispose(); return; }
      candidate = result;
      if (result.status === 'completed') {
        const call = result.results?.find(item => item.kind === 'contact' && item.mode === 'audio-call');
        note(result.kind === 'message' ? '共享留言已保存到家庭记忆，家庭成员均可见。' : call ? '语音呼叫请求已发出，等待对方接听；尚未确认音频连接。' : '联系提醒已发出。请在“联系家人”查看对方是否确认收到；尚未建立音频通话。');
        el('actionCancel').textContent = '收起'; el('actionCancel').disabled = false; el('actionCancel').onclick = dispose;
        if (call) { globalThis.MemoryAI?.pauseForCall(); globalThis.MemoryCall?.start(result.targetId, { callId: call.callId }); pendingCall = null; }
        if (session?.token === token) poll(); globalThis.MemoryContact?.refresh();
      } else { note('行动仍在处理，可稍后重试确认以查询同一行动，重复确认不会重复发送。'); el('actionConfirm').disabled = false; }
    } catch (e) { if (live(version)) {
      const needsChange = [400, 401, 403, 404, 410].includes(e.status);
      note(e.message + (needsChange ? '；请修改或取消本次候选。' : '；如结果不确定，可重试同一确认，系统不会重复发送。'));
      el('actionConfirm').disabled = needsChange; el('actionModify').disabled = false; el('actionCancel').disabled = false;
    } }
    finally { if (live(version)) sending = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && pendingCall) dispose(); });
  globalThis.addEventListener('pagehide', dispose);
  return { suggest, dispose };
})();
