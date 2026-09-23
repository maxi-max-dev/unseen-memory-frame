'use strict';
globalThis.MemoryAI = (() => {
  let dialog, controller, recorder, focusOrigin, proactiveRun = null, suspended = false, checkingCaps = false, epoch = 0, history = [], caps = null, identity = '', capturing = false, busy = false, answer = '', picked = [], voice = null, voiceURL = '';
  const automaticHistory = new WeakSet();
  const el = id => dialog?.querySelector('#' + id);
  const status = message => { if (el('aiStatus')) el('aiStatus').textContent = message; };
  const active = generation => dialog?.open && generation === epoch && identity === session?.token && !sessionExpired;
  function cancel(message = '已停止。可以继续输入问题。') {
    proactiveRun = null;
    const wasChecking = checkingCaps; checkingCaps = false;
    epoch++; controller?.abort(); controller = null; recorder?.cancel(); recorder = null; capturing = false; busy = false;
    globalThis.speechSynthesis?.cancel(); dialog?.querySelectorAll('audio').forEach(audio => audio.pause()); update(); status(message);
    if (dialog && (!caps || wasChecking)) { el('aiCapabilities').textContent = '功能检查已暂停，请重试。'; el('aiRetry').hidden = false; }
  }
  function clearVoice() { el('aiVoicePreview')?.querySelectorAll('audio').forEach(audio => audio.pause()); voice = null; if (voiceURL) URL.revokeObjectURL(voiceURL); voiceURL = ''; el('aiVoicePreview')?.replaceChildren(); }
  function dispose(hideEntry = false) { cancel(''); globalThis.MemoryRealtime?.dispose(); globalThis.MemoryActionUI?.dispose(); clearVoice(); history = []; picked = []; answer = ''; identity = ''; suspended = false; dialog?.close(); dialog?.remove(); dialog = null; const entry = document.querySelector('#openAI'); if (entry && hideEntry === true) entry.hidden = true; if (hideEntry === true) document.querySelector('#aiHomeEntry')?.remove(); }
  function close() { const origin = focusOrigin; dispose(); if (origin?.isConnected && !origin.hidden) origin.focus?.({ preventScroll: true }); }
  function suspendForRealtime() {
    if (!dialog?.open) return suspended;
    cancel('已暂停文字聊天。返回后可以继续。'); globalThis.MemoryActionUI?.dispose();
    // Retain this window's draft/history in memory only; cancel all pending work.
    suspended = true; dialog.close(); dialog.remove(); return true;
  }
  async function resume() {
    if (globalThis.MemoryCall?.busy?.()) return toast('请先结束家人通话或关闭通话窗口');
    if (recording || (typeof recordingStarting !== 'undefined' && recordingStarting)) return toast('请先结束正在录给家人的原声或等待中的录音授权');
    if (!suspended || identity !== session?.token || sessionExpired) return open();
    globalThis.MemoryRealtime?.dispose(); suspended = false; document.body.append(dialog); dialog.showModal();
    status('已返回文字聊天，原有内容已保留。'); el('aiQuestion').focus?.();
    if (!caps) await checkCapabilities();
  }
  function update() {
    if (!dialog) return;
    const vision = Boolean(el('aiReadPhoto')?.checked);
    el('aiSend').disabled = busy || capturing || checkingCaps || !!proactiveRun || !caps || !(vision ? caps.vision : caps.text);
    el('aiRecord').disabled = busy || checkingCaps || !!proactiveRun || !caps?.asr;
    el('aiRetry').disabled = busy || capturing || checkingCaps;
    el('aiRecord').textContent = capturing ? '结束录音并转写' : '用语音输入';
    el('aiMemory').disabled = busy || capturing || !!proactiveRun; el('aiAddPhoto').disabled = busy || capturing || !!proactiveRun || picked.length >= 4;
    el('aiReadPhoto').disabled = busy || capturing || !!proactiveRun || !caps?.vision || !picked.length;
    el('aiPhotoChoice').hidden = !picked.length;
    el('aiPhotos').querySelectorAll('button').forEach(button => { button.disabled = busy || capturing || !!proactiveRun; });
    el('aiQuestion').disabled = busy || capturing || !!proactiveRun;
    el('aiSpeak').disabled = busy || capturing || !answer || !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance;
  }
  function renderPhotos() {
    const box = el('aiPhotos'); box.replaceChildren();
    picked.forEach((id, index) => {
      const m = state?.messages.find(item => item._id === id), item = document.createElement('div');
      if (m?.imageURL) { const img = document.createElement('img'); img.src = m.imageURL; img.alt = `对话照片 ${index + 1}`; item.append(img); }
      const text = document.createElement('span'); text.textContent = `照片 ${index + 1} · ${m?.title || m?.card?.title || '家庭照片'}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除对话照片 ${index + 1}`);
      remove.onclick = () => { picked = picked.filter(value => value !== id); if (!picked.length) el('aiReadPhoto').checked = false; renderPhotos(); update(); status('照片已移除，聊天记录保留。下一次只读取当前选中的照片。'); };
      item.append(text, remove); box.append(item);
    });
  }
  function renderHistory() {
    const box = el('aiMessages'); box.replaceChildren();
    for (const item of history) { if (automaticHistory.has(item)) continue; const p = document.createElement('p'); const label = document.createElement('strong'); label.textContent = item.role === 'user' ? '你：' : 'AI：'; p.append(label, document.createTextNode(item.content)); box.append(p); }
    box.scrollTop = box.scrollHeight;
  }
  async function request(action, data, generation) {
    const pending = new AbortController(); controller = pending; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; pending.abort(); }, 65000);
    try {
      const result = await api(action, data, identity, { signal: pending.signal });
      if (!active(generation)) return null;
      return result;
    } catch (e) { if (timedOut) throw Error('等待 AI 服务超时，请稍后重试；没有执行留言或联系操作'); throw e; }
    finally { clearTimeout(timer); }
  }
  async function send(event) {
    event?.preventDefault(); if (busy || capturing || el('aiSend').disabled) return;
    const question = el('aiQuestion').value.trim(); if (!question) { status('请先输入问题，或录音转成文字。'); el('aiQuestion').focus?.(); return; }
    const restoreInput = [el('aiQuestion'), el('aiSend')].includes(document.activeElement);
    const generation = ++epoch; busy = true; globalThis.speechSynthesis?.cancel(); update(); status('AI 正在思考…');
    try {
      const readPhoto = el('aiReadPhoto').checked;
      const result = await request('aiChat', { text: question, history: history.slice(-12), messageIds: [...picked], readPhoto }, generation);
      if (!result) return;
      history.push({ role: 'user', content: question }, { role: 'assistant', content: result.answer }); history = history.slice(-12);
      answer = result.answer; el('aiQuestion').value = ''; renderHistory(); status(result.imageUsed ? 'AI 已结合照片回答；看不清的内容请由家人补充。' : 'AI 已回复。本次依据文字对话，没有读取照片。');
      if (result.action) globalThis.MemoryActionUI?.suggest({ container: el('aiAction'), suggestion: result.action, messageIds: [...picked], voice, token: identity });
    } catch (e) { if (active(generation) && e.name !== 'AbortError') status(e.message); }
    finally { if (active(generation)) { busy = false; update(); if (restoreInput && document.activeElement === document.body) el('aiQuestion').focus?.(); } }
  }
  async function finishVoice() {
    if (!capturing || busy) return;
    const generation = epoch; capturing = false; busy = true; update(); status('正在转写语音…');
    try {
      const blob = await recorder.finish(); if (!blob || !active(generation)) return;
      clearVoice(); voice = blob; voiceURL = URL.createObjectURL(blob);
      const audio = document.createElement('audio'); audio.controls = true; audio.src = voiceURL; audio.setAttribute('aria-label', '本次原声试听');
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除这段原声'; remove.onclick = clearVoice; el('aiVoicePreview').append(audio, remove);
      const encoded = await base64(blob); if (!active(generation)) return;
      const result = await request('aiTranscribe', { base64: encoded }, generation); if (!result) return;
      el('aiQuestion').value = result.text; status('语音已转成文字，请检查后点击发送。');
    } catch (e) { if (active(generation) && e.name !== 'AbortError') status(e.message); }
    finally { if (active(generation)) { busy = false; recorder = null; update(); } }
  }
  async function record() {
    if (capturing) return finishVoice(); if (busy) return;
    if (recording || (typeof recordingStarting !== 'undefined' && recordingStarting)) return status('请先结束正在录给家人的原声或等待中的录音授权。');
    const generation = ++epoch; busy = true; globalThis.speechSynthesis?.cancel(); update(); status('请允许麦克风，录音最长 60 秒。');
    recorder = MemoryVoice.create({ onTimeout: finishVoice });
    try { const started = await recorder.start(); if (active(generation) && started) { capturing = true; status('正在录音，最长 60 秒。说完后点击结束录音。'); } }
    catch (e) { if (active(generation)) status(e.message); }
    finally { if (active(generation)) { busy = false; update(); } }
  }
  function speak() {
    if (!answer || !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) return;
    globalThis.speechSynthesis.cancel(); const generation = epoch, utterance = new SpeechSynthesisUtterance(answer);
    utterance.lang = 'zh-CN'; utterance.rate = 0.95;
    const voice = speechSynthesis.getVoices().find(v => /^zh/i.test(v.lang)); if (voice) utterance.voice = voice;
    utterance.onend = () => { if (active(generation)) status('朗读结束。'); };
    utterance.onerror = () => { if (active(generation)) status('设备朗读失败，可以阅读文字或重试。'); };
    status('正在用设备语音朗读，可点击停止。'); speechSynthesis.speak(utterance);
  }
  async function checkCapabilities() {
    if (busy || capturing || checkingCaps) return;
    const generation = ++epoch; checkingCaps = true; update(); el('aiRetry').hidden = true; el('aiCapabilities').textContent = '正在检查可用功能…';
    try {
      const available = await request('aiCapabilities', {}, generation); if (!active(generation) || !available) return;
      caps = available;
      el('aiCapabilities').textContent = [caps.text ? '可以打字聊天' : '文字聊天暂不可用', caps.vision ? '可以一起看照片' : '暂不能读取照片内容', caps.asr ? '可以用语音输入' : '语音输入暂不可用'].join(' · ');
      status('输入后发送；按 Ctrl 或 ⌘ + Enter 也可发送。语音转写可修改后再发送。'); update();
      el('aiRetry').hidden = Boolean(caps.text && caps.vision && caps.asr);
    } catch (e) {
      if (active(generation)) { el('aiCapabilities').textContent = '暂时无法检查聊天功能，请检查网络后重试。'; el('aiRetry').hidden = false; status('输入内容会保留。'); }
    } finally { if (active(generation)) { checkingCaps = false; update(); } }
  }
  async function openConversation(messageId = '', fromPresence = false) {
    if (globalThis.MemoryCall?.busy?.()) return toast('请先结束家人通话或关闭通话窗口');
    if (!session || sessionExpired) return toast('请先登录家庭');
    if (recording || (typeof recordingStarting !== 'undefined' && recordingStarting)) return toast('请先结束正在录给家人的原声或等待中的录音授权');
    const origin = document.activeElement; dispose(); focusOrigin = origin; identity = session.token; caps = null;
    dialog = document.createElement('dialog'); dialog.className = 'ai-dialog'; dialog.setAttribute('aria-labelledby', 'aiTitle');
    const run = fromPresence ? { dialog, token: identity, room: session.room, photoId: messageId, image: presencePhoto(messageId)?.image } : null;
    proactiveRun = run;
    dialog.innerHTML = `<div class="row between ai-dialog-heading"><h2 id="aiTitle">和 AI 聊聊</h2><button id="aiClose" type="button" aria-label="关闭 AI 对话">关闭 ×</button></div><p class="muted">可以随便聊聊，也可加照片。聊天仅保留本窗口最近 6 轮；切换实时语音后返回仍可继续。</p><details id="aiPhotoPicker" class="ai-photo-picker"><summary>添加家庭照片（可选，最多 4 张）</summary><label>选择照片（合计不超过 8 MB）<select id="aiMemory"><option value="">选择照片</option></select></label><button id="aiAddPhoto" type="button">添加到对话</button></details><div id="aiPhotos" class="ai-photos" aria-label="当前对话照片"></div><label id="aiPhotoChoice" class="ai-photo-choice"><input id="aiReadPhoto" type="checkbox">让 AI 读取当前选中的照片</label><p id="aiCapabilities" class="muted">正在检查可用功能…</p><button id="aiRetry" type="button" hidden>重新检查聊天功能</button><div id="aiMessages" class="ai-messages" role="log" aria-label="本次对话" aria-live="polite"></div><form id="aiForm"><label>想说的话<textarea id="aiQuestion" autofocus maxlength="2000" rows="3" placeholder="聊聊今天，比较照片，或请 AI 帮你给家人留言"></textarea></label><div class="row"><button id="aiSend" class="primary" type="submit">发送</button><button id="aiRecord" type="button">用语音输入</button><button id="aiStop" type="button">停止</button></div></form><div id="aiVoicePreview"></div><p id="aiStatus" role="status" aria-live="polite"></p><div class="row"><button id="aiSpeak" type="button">朗读回复</button><button id="aiNew" type="button">清空对话</button></div><div id="aiAction"></div><small>AI 回复不会自动写入家庭记忆。语音输入会交给识别服务转写；朗读使用设备语音，音色与可用性因设备而异。关闭或切到后台会停止录音和朗读。留言与联系必须另行检查确认卡片，语音中的“好”不会执行操作。</small>`;
    document.body.append(dialog);
    const liveButton = document.createElement('button'); liveButton.id = 'aiRealtimeEntry'; liveButton.type = 'button'; liveButton.className = 'ai-realtime-entry'; liveButton.textContent = '想直接说话？打开实时语音';
    liveButton.onclick = () => globalThis.MemoryRealtime?.open(); el('aiTitle').parentNode.after(liveButton);
    for (const m of (state?.messages || []).filter(m => !m.deleted && m.type === 'photo' && m.image)) { const option = document.createElement('option'); option.value = m._id; option.textContent = m.title || m.card?.title || (m.text || '一份家庭记忆').slice(0, 28); el('aiMemory').append(option); }
    if ([...el('aiMemory').options].some(o => o.value === messageId) && messageId) { picked = [messageId]; el('aiPhotoPicker').open = !fromPresence; renderPhotos(); }
    el('aiClose').onclick = close; dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    el('aiForm').onsubmit = send; el('aiRetry').onclick = checkCapabilities;
    el('aiQuestion').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !el('aiSend').disabled) { event.preventDefault(); void send(); } };
    el('aiRecord').onclick = record; el('aiStop').onclick = () => cancel(); el('aiSpeak').onclick = speak;
    el('aiNew').onclick = () => { cancel('已清空对话。'); globalThis.MemoryActionUI?.dispose(); clearVoice(); history = []; answer = ''; renderHistory(); update(); };
    el('aiAddPhoto').onclick = () => { const id = el('aiMemory').value; if (!id || picked.includes(id)) return; if (picked.length >= 4) return status('最多选择 4 张照片。'); picked.push(id); renderPhotos(); update(); status('照片已添加，聊天记录保留。可勾选让 AI 读取照片。'); };
    el('aiReadPhoto').onchange = () => { update(); status('照片读取方式已更新，聊天记录保留。'); };
    dialog.showModal(); update();
    const capabilities = checkCapabilities();
    if (run) run.epoch = epoch;
    await capabilities;
    if (run) return askFromPresence(run);
  }

  // The ordinary entry keeps its existing manual photo/voice behavior.
  function open(messageId = '') { return openConversation(messageId); }
  function presencePhoto(messageId) { return state?.messages.find(message => message._id === messageId && !message.deleted && message.type === 'photo' && message.image && message.imageURL); }
  function presenceContext(run) {
    return proactiveRun === run && run.dialog === dialog && run.token === identity && active(run.epoch)
      && session?.room === run.room && !document.hidden && presencePhoto(run.photoId)?.image === run.image
      && !recording && !(typeof recordingStarting !== 'undefined' && recordingStarting)
      && !globalThis.MemoryRealtime?.busy() && !globalThis.MemoryCall?.busy?.();
  }
  function refreshProactive() {
    const run = proactiveRun; if (!run || presenceContext(run)) return;
    // Cancel immediately when a state refresh removes/replaces the consented photo.
    // Never update a newer conversation, even when it contains the same photo.
    if (dialog !== run.dialog) { proactiveRun = null; return; }
    const missingPhoto = presencePhoto(run.photoId)?.image !== run.image;
    if (missingPhoto) { picked = picked.filter(id => id !== run.photoId); el('aiReadPhoto').checked = false; renderPhotos(); }
    cancel(missingPhoto ? '这张照片已不可用，已停止读取。可以直接聊聊。' : '已停止自动提问。可以直接输入想说的话。');
  }
  function presenceFallback(run, message) {
    if (!presenceContext(run)) { refreshProactive(); return { opened: false, outcome: 'cancelled' }; }
    proactiveRun = null; busy = false; el('aiReadPhoto').checked = false; update(); status(message);
    return { opened: true, outcome: 'fallback' };
  }
  async function askFromPresence(run) {
    if (!presenceContext(run)) { refreshProactive(); return { opened: false, outcome: 'cancelled' }; }
    if (!caps?.vision) return presenceFallback(run, '暂时无法读取照片，已保留普通对话。可以直接输入，或稍后重新检查聊天功能。');
    el('aiReadPhoto').checked = true; run.epoch = ++epoch; busy = true; update(); status('AI 正在看这张照片，准备问您一句…');
    try {
      const result = await request('aiChat', {
        text: '请根据当前这张照片，只提出一句简短、温和、开放式的问题，邀请我分享回忆。仅提及能够明确看见的细节，不猜测人物身份、亲属关系、地点、时间、情绪或照片背后的经历。看不清时问“这张照片让您想起了什么？”这类不预设事实的问题。只返回一个问句，不解释分析，也不提出留言或联系建议。',
        history: [], messageIds: [run.photoId], readPhoto: true
      }, run.epoch);
      if (!presenceContext(run)) { refreshProactive(); return { opened: false, outcome: 'cancelled' }; }
      const question = typeof result?.answer === 'string' ? result.answer.trim() : '';
      // Keep this entry to one short question. Unexpected/empty/nonvisual replies
      // return to ordinary chat, and action suggestions are never executed here.
      if (!result?.imageUsed || !question || question.length > 160 || !/^[^。！？!?\n\r]+[？?]$/.test(question)) {
        return presenceFallback(run, '暂时没能生成合适的开场问题。已保留普通对话，可以直接聊聊。');
      }
      // The API requires complete user/assistant pairs for the next manual turn.
      const seed = { role: 'user', content: '请根据这张照片，先问我一个问题。' };
      automaticHistory.add(seed); // Internal context is not something the elder said.
      history = [seed, { role: 'assistant', content: question }];
      answer = question; proactiveRun = null; busy = false; renderHistory(); update();
      status('AI 已结合这张照片提问。您可以慢慢打字回答，或自己点击“用语音输入”。');
      return { opened: true, outcome: 'question' };
    } catch (error) {
      if (!presenceContext(run)) { refreshProactive(); return { opened: false, outcome: 'cancelled' }; }
      return presenceFallback(run, '暂时没能读取照片并提问。已保留普通对话，可以直接输入想说的话。');
    }
  }
  function openFromPresence(messageId) {
    // Only the explicitly accepted frame invitation calls this controlled entry.
    if (!frame || session?.role !== 'frame' || !session?.token || sessionExpired || document.hidden
      || dialog?.open || suspended || busy || capturing || checkingCaps || recording
      || (typeof recordingStarting !== 'undefined' && recordingStarting) || !presencePhoto(messageId)) {
      return Promise.resolve({ opened: false, outcome: 'unavailable' });
    }
    return openConversation(messageId, true);
  }

  function mount() {
    let button = document.querySelector('#openAI');
    if (!button) { button = document.createElement('button'); button.id = 'openAI'; button.textContent = 'AI 聊天'; document.querySelector('#settings').before(button); }
    button.hidden = false; button.onclick = () => open(frame ? current()?._id : '');
    if (!document.querySelector('#aiHomeEntry')) {
      const host = document.querySelector(frame ? '#app .subheading' : '#familyHome .home-actions') || document.querySelector('#familyHome .subheading');
      if (host) {
        const card = document.createElement('section'); card.id = 'aiHomeEntry'; card.className = 'ai-home-entry'; card.setAttribute('aria-label', 'AI 聊天入口');
        card.innerHTML = '<div><strong>有话想说，和 AI 聊聊</strong><p>聊聊今天，也可以一起看看家里的照片。</p></div><div class="row"><button id="aiHomeChat" class="primary" type="button">和 AI 聊天</button><button id="aiHomeLive" type="button">实时语音</button></div>';
        host.after(card); card.querySelector('#aiHomeChat').onclick = () => open(); card.querySelector('#aiHomeLive').onclick = () => globalThis.MemoryRealtime?.open();
      }
    }
  }
  function addMemoryEntry(m) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '和 AI 聊这份记忆'; button.className = 'quiet';
    button.onclick = () => { document.querySelector('#modal').close(); open(m._id); }; document.querySelector('#modalBody h2')?.after(button);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && dialog?.open) cancel('页面已切到后台，录音和朗读已停止。'); });
  globalThis.addEventListener('pagehide', () => dispose());
  return { busy: () => Boolean(dialog?.open || busy || capturing || checkingCaps), open, openFromPresence, refreshProactive, mount, dispose, resume, suspendForRealtime, addMemoryEntry, pauseForCall: () => cancel('AI 录音和朗读已暂停，可以和家人通话。') };
})();
