'use strict';
globalThis.MemoryCall = (() => {
  const LIVE = new Set(['ringing', 'accepted', 'connecting']);
  const TERMINAL = new Set(['ended', 'declined', 'failed', 'expired']);
  const labels = { ended: '通话已结束。', declined: '对方暂时不方便接听。', failed: '通话连接已中断。', expired: '呼叫或通话已到期。' };
  let dialog, notice, audio, identity = '', epoch = 0, capabilities, members = [], calls = [], call = null, run = null;
  let pollTimer, deadlineTimer, checking = false, busy = false, lastCheck = 0, selected = '', retryStart = null, stopReason = '';
  const controllers = new Set(), dismissed = new Set(), mediaIntent = new Set(), terminations = new Map();
  const auth = () => typeof session !== 'undefined' && !sessionExpired ? session?.token || '' : '';
  const current = (token, generation) => token && token === auth() && token === identity && generation === epoch;
  const liveRun = r => run === r && current(r.token, r.generation) && dialog?.open && !document.hidden && mediaIntent.has(r.id) && call?.id === r.id && LIVE.has(call.status);
  const el = id => dialog?.querySelector('#' + id);
  function status(text) { if (el('callStatus')) el('callStatus').textContent = text; }
  function unsupported() {
    if (!globalThis.isSecureContext) return '语音通话需要 HTTPS 安全页面。';
    if (!globalThis.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) return '此浏览器不支持当前语音通话，请换用支持 WebRTC 的浏览器。';
    return '';
  }
  function mediaBlocked() {
    if (navigator.onLine === false) return '网络已断开，请恢复连接后再呼叫。';
    if ((typeof recording !== 'undefined' && recording) || (typeof recordingStarting !== 'undefined' && recordingStarting)) return '请先结束正在录给家人的原声或等待中的录音授权，再继续通话。';
    if (globalThis.MemoryRealtime?.busy()) return '请先挂断 AI 实时对话并确认结束，再与家人通话。';
    return '';
  }
  function ensure() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.id = 'familyCallDialog'; dialog.className = 'family-call-dialog'; dialog.setAttribute('aria-labelledby', 'callTitle');
    dialog.innerHTML = '<div class="call-heading"><h2 id="callTitle">和家人语音通话</h2><button id="callClose" type="button">关闭</button></div><p class="call-description">双方需打开页面。接听后才申请麦克风权限。关闭窗口、切到后台或退出登录会结束通话；这里不会拨打电话号码。</p><p id="callCapability"></p><div id="callContent"></div><p id="callStatus" role="status" aria-live="polite"></p><button id="callListen" type="button" hidden>点击收听对方声音</button><button id="callReminder" type="button">改用站内联系提醒</button><div id="callAudio"></div>';
    document.body.append(dialog);
    audio = document.createElement('audio'); audio.autoplay = false; audio.controls = false; audio.setAttribute('playsinline', ''); el('callAudio').append(audio);
    el('callClose').onclick = () => { end('hangup', '窗口已关闭，通话已结束。'); dialog?.close(); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); end('hangup', '窗口已关闭，通话已结束。'); dialog?.close(); });
    dialog.addEventListener('close', () => { if (dialog && !dialog.open && (call || retryStart)) end('hangup', '窗口已关闭，通话已结束。'); });
    el('callListen').onclick = () => run && play(run);
    el('callReminder').onclick = () => { if (call) return; end('cancelled', ''); dialog.close(); globalThis.MemoryContact?.open(); };
    notice = document.createElement('button'); notice.id = 'familyCallNotice'; notice.type = 'button'; notice.hidden = true; notice.setAttribute('aria-live', 'polite'); notice.onclick = () => open(); document.body.append(notice);
  }
  async function request(action, data, token = identity, observe) {
    const monotonic = () => globalThis.performance?.now?.() ?? Date.now(), started = monotonic();
    const controller = new AbortController(); controllers.add(controller);
    let timer, onAbort;
    const stopped = new Promise((resolve, reject) => {
      onAbort = () => reject(Object.assign(new Error('通话请求已停止或超时。'), { name: 'AbortError' }));
      controller.signal.addEventListener('abort', onAbort, { once: true }); timer = setTimeout(() => controller.abort(), 12000);
    });
    try { return await Promise.race([Promise.resolve(api(action, data, token, { signal: controller.signal })).then(result => {
      observe?.(result);
      // Include the full round trip conservatively: slow responses must not extend
      // the server's ringing or call deadline on this device.
      return Number.isFinite(result?.serverTime) ? { ...result, serverTime: result.serverTime + Math.max(0, monotonic() - started) } : result;
    }), stopped]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controllers.delete(controller); }
  }
  const pendingMessage = '本机通话与麦克风已关闭，服务器尚未确认结束；恢复连接后将重试。';
  const terminationMessage = pending => [stopReason, pending ? pendingMessage : '服务器已确认呼叫结束，本机麦克风已关闭。'].filter(Boolean).join(' ');
  function pruneTerminations() {
    for (const [key, entry] of terminations) if (!entry.inFlight && Date.now() - entry.createdAt > 86400000) terminations.delete(key);
  }
  function hasPendingCancellations(token = auth()) { pruneTerminations(); return [...terminations.values()].some(entry => entry.token === token); }
  function canStart(token = auth()) { pruneTerminations(); return Boolean(token) && terminations.size < 20 && !hasPendingCancellations(token); }
  async function terminateEntry(key, entry) {
    const controller = new AbortController(); let timer;
    try {
      const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('termination timeout')); }, 4000); });
      let result, otherDevice = false;
      try { result = await Promise.race([api(entry.action, entry.data, entry.token, { signal: controller.signal }), timeout]); }
      catch (error) {
        if (entry.action !== 'callReject' || ![403, 409].includes(error.status) || controller.signal.aborted) throw error;
        // A different device may have accepted after this device's last ringing snapshot.
        // Recheck through the original authenticated identity within the same deadline;
        // never turn a permission/conflict error itself into proof of termination.
        result = await Promise.race([api('callState', { id: entry.data.id }, entry.token, { signal: controller.signal }), timeout]);
        otherDevice = result?.call?.id === entry.data.id && result.call.direction === 'incoming' && result.call.canControl === false && ['accepted', 'connecting'].includes(result.call.status);
      }
      const confirmed = otherDevice || (entry.action === 'callCancelStart' ? result?.cancelled === true : result?.call?.id === entry.data.id && TERMINAL.has(result.call.status));
      if (!confirmed) throw Error('termination unconfirmed');
      if (result?.callId || result?.call?.id) dismissed.add(result.callId || result.call.id);
      terminations.delete(key);
      if (identity === entry.token && !call && !busy && !hasPendingCancellations(entry.token)) status(otherDevice ? '已由另一设备接听，本机不再参与。' : terminationMessage(false));
    } catch { if (identity === entry.token && !call) status(terminationMessage(true)); }
    finally { clearTimeout(timer); entry.inFlight = false; entry.promise = null; }
  }
  async function flushTerminations(token) {
    pruneTerminations(); const pending = [];
    for (const [key, entry] of terminations) {
      if (entry.token !== token) continue;
      if (!entry.inFlight) { entry.inFlight = true; entry.promise = terminateEntry(key, entry); }
      pending.push(entry.promise);
      if (pending.length >= 2) break; // At most two bounded final writes per authenticated refresh.
    }
    await Promise.all(pending);
  }
  function queueTermination(action, data, token) {
    if (!token) return false;
    pruneTerminations(); const key = token + ':' + action + ':' + (data.id || data.requestId);
    if (!terminations.has(key)) {
      if (terminations.size >= 20) { if (identity === token) status('待确认的结束请求较多，请恢复连接后重试。'); return false; }
      terminations.set(key, { action, data, token, createdAt: Date.now(), inFlight: false, promise: null });
    }
    if (data.id) dismissed.add(data.id);
    flushTerminations(token); return true;
  }
  function bestEffortEnd(id, token, reason, action = 'callEnd') {
    if (!id) return false;
    return queueTermination(action, action === 'callReject' ? { id } : { id, reason }, token);
  }
  function cancelStart(requestId, token = auth()) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) return false;
    return queueTermination('callCancelStart', { requestId }, token);
  }
  function cancelPendingStart(token) {
    if (!retryStart || !token) return;
    cancelStart(retryStart.requestId, token);
  }
  function release() {
    epoch++; clearTimeout(pollTimer); clearTimeout(deadlineTimer); pollTimer = null; deadlineTimer = null;
    for (const controller of controllers) controller.abort(); controllers.clear(); checking = false; busy = false;
    const old = run; run = null;
    if (old) {
      clearTimeout(old.connectTimer); clearTimeout(old.iceTimer);
      if (old.pc) { old.pc.ontrack = null; old.pc.onicecandidate = null; old.pc.onconnectionstatechange = null; old.pc.close(); }
      for (const stream of [old.local, old.remote]) stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      old.pendingIce = []; old.seen.clear();
    }
    if (audio) { audio.pause(); audio.srcObject = null; }
    if (el('callListen')) el('callListen').hidden = true;
  }
  function end(reason = 'hangup', message = '通话已结束。', notify = true) {
    const old = call, token = identity;
    stopReason = message.replace(/通话已结束/g, '本机通话已停止');
    if (old) dismissed.add(old.id);
    if (notify) cancelPendingStart(token);
    mediaIntent.clear(); release(); call = null; retryStart = null; render(); status(message);
    if (notify && old && LIVE.has(old.status)) {
      if (old.canControl) bestEffortEnd(old.id, token, reason);
      else if (old.direction === 'incoming' && old.status === 'ringing') bestEffortEnd(old.id, token, reason, 'callReject');
    }
    if (hasPendingCancellations(token)) status(terminationMessage(true));
  }
  function dispose() {
    end('hangup', '', true); dialog?.close(); dialog?.remove(); notice?.remove();
    dialog = null; notice = null; audio = null; identity = ''; capabilities = null; members = []; calls = []; selected = ''; lastCheck = 0; dismissed.clear();
  }
  function button(text, handler, disabled = false) {
    const result = document.createElement('button'); result.type = 'button'; result.textContent = text; result.disabled = disabled; result.onclick = handler; return result;
  }
  function render() {
    if (!dialog) return;
    const reason = unsupported() || (!capabilities?.enabled ? capabilities?.reason || '正在检查通话配置…' : '语音通话已配置；实际连接取决于双方网络与麦克风权限。');
    el('callCapability').textContent = reason;
    el('callClose').textContent = call ? '挂断并关闭' : '关闭';
    el('callReminder').disabled = Boolean(call);
    const box = el('callContent'); box.replaceChildren();
    if (call && LIVE.has(call.status)) {
      const name = call.direction === 'incoming' ? call.from.name : call.to.name;
      const title = document.createElement('p'); title.textContent = `${call.direction === 'incoming' ? '来自' : '呼叫'} ${name}`; box.append(title);
      if (call.status === 'ringing') {
        const text = document.createElement('p'); text.textContent = call.direction === 'incoming' ? '家人正在呼叫你。点击接听后会申请麦克风权限。' : '正在呼叫，等待家人主动接听。麦克风尚未开启。'; box.append(text);
        if (call.direction === 'incoming') {
          const accept = button('接听语音通话', () => respond('callAccept'), busy || !capabilities?.enabled || Boolean(unsupported())); accept.id = 'callAccept';
          const reject = button('暂不方便', () => respond('callReject'), busy); reject.id = 'callReject'; box.append(accept, reject);
        }
      } else if (!call.canControl) {
        const other = document.createElement('p'); other.textContent = '此通话已在另一台设备接听。'; box.append(other);
      }
      if (call.canControl && !mediaIntent.has(call.id) && (call.direction === 'outgoing' || call.status !== 'ringing')) {
        const resume = button('确认继续这次语音通话', () => {
          if (!dialog?.open || !call) return;
          if (!canStart(identity)) return status('上次呼叫的结束或取消仍待服务器确认，请稍后重试。');
          const blocked = mediaBlocked(); if (blocked) return status(blocked);
          mediaIntent.add(call.id); render(); if (call.status !== 'ringing') begin(call);
        }, busy || !capabilities?.enabled || Boolean(unsupported())); resume.id = 'callResume'; box.append(resume);
      }
      if (call.canControl || call.direction === 'outgoing') { const hangup = button(call.status === 'ringing' ? '取消呼叫' : '挂断', () => end('hangup'), false); hangup.id = 'callHangup'; box.append(hangup); }
    } else {
      const label = document.createElement('label'); label.textContent = '选择家庭成员';
      const select = document.createElement('select'); select.id = 'callRecipient'; select.setAttribute('aria-label', '通话对象');
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '请选择真实家庭成员'; select.append(empty);
      for (const member of members) { const option = document.createElement('option'); option.value = member.id; option.textContent = `${member.name} · ${member.role === 'frame' ? '相框' : '家人'} · ${member.id.slice(-6)}`; select.append(option); }
      select.value = members.some(member => member.id === selected) ? selected : ''; select.disabled = busy;
      select.onchange = () => { cancelPendingStart(identity); selected = select.value; retryStart = null; render(); };
      label.append(select); box.append(label);
      const chosen = members.find(member => member.id === selected), summary = document.createElement('p'); summary.textContent = chosen ? `确认呼叫 ${chosen.name}（${chosen.id.slice(-6)}）进行实时语音通话。对方接听后，双方才会开启麦克风。` : '请选择通话对象，再确认发起呼叫。'; box.append(summary);
      const start = button('确认呼叫这位家人', initiate, busy || !chosen || !capabilities?.enabled || Boolean(unsupported())); start.id = 'callStart'; box.append(start);
    }
    const incoming = calls.find(item => item.direction === 'incoming' && item.status === 'ringing' && !dismissed.has(item.id));
    notice.hidden = !incoming || dialog.open; notice.textContent = incoming ? `${incoming.from.name} 正在呼叫你 · 点击接听` : '';
  }
  function schedule() {
    clearTimeout(pollTimer); pollTimer = null;
    if (!auth() || document.hidden || (!call && !dialog?.open)) return;
    pollTimer = setTimeout(() => refresh(true), call ? Math.max(1000, Math.min(5000, capabilities?.pollIntervalMs || 1500)) : 5000);
  }
  function setDeadline(value, serverTime) {
    clearTimeout(deadlineTimer);
    const expires = value.status === 'ringing' ? value.ringExpiresAt : value.expiresAt;
    if (!Number.isFinite(expires)) return;
    const id = value.id, generation = epoch, remaining = Math.max(0, expires - (Number.isFinite(serverTime) ? serverTime : Date.now()));
    deadlineTimer = setTimeout(() => { if (call?.id === id && generation === epoch) end('hangup', '呼叫或通话已到期。'); }, remaining);
  }
  async function apply(result, token, generation) {
    if (!current(token, generation)) return;
    if (result.capabilities) capabilities = result.capabilities;
    if (result.members) members = result.members;
    if (result.calls) calls = result.calls;
    if (!capabilities?.enabled || unsupported()) { if (call) end('failed', unsupported() || capabilities?.reason || '语音通话已停用。'); render(); return; }
    const next = result.call || (call && calls.find(item => item.id === call.id)) || (!call && calls.find(item => LIVE.has(item.status) && !dismissed.has(item.id)));
    if (next && !dismissed.has(next.id)) {
      if (!call && !dialog?.open && (next.direction === 'outgoing' || next.status !== 'ringing')) { render(); return; }
      if (call && call.id !== next.id) return;
      if (call?.revision > next.revision) return;
      call = next;
      const expires = next.status === 'ringing' ? next.ringExpiresAt : next.expiresAt;
      if (LIVE.has(next.status) && Number.isFinite(expires) && expires <= (Number.isFinite(result.serverTime) ? result.serverTime : Date.now())) return end('hangup', '呼叫或通话已到期。');
      setDeadline(next, result.serverTime);
      if (!LIVE.has(next.status)) { end('hangup', labels[next.status] || '通话已结束。', false); return; }
      render();
      if (next.status !== 'ringing' && next.canControl && dialog?.open && !document.hidden && mediaIntent.has(next.id)) {
        if (!run) begin(next);
        else await negotiate(run, next.peer);
      }
    } else render();
  }
  async function refresh(force = false) {
    const token = auth(); if (!token) { dispose(); return; }
    if (identity && identity !== token) dispose(); identity = token; ensure();
    if (checking || busy || document.hidden || (!force && Date.now() - lastCheck < 1400)) return;
    checking = true; lastCheck = Date.now(); const generation = epoch;
    try { await flushTerminations(token); if (!current(token, generation)) return; const result = await request('callState', call ? { id: call.id } : {}, token); await apply(result, token, generation); }
    catch (error) { if (current(token, generation)) { if (call) end('failed', '通话状态同步失败，麦克风已关闭，请重新呼叫。'); else status(error.name === 'AbortError' ? '读取通话状态超时，请重试。' : error.message); } }
    finally { if (current(token, generation)) { checking = false; schedule(); } }
  }
  async function initiate() {
    if (busy || call || !capabilities?.enabled || unsupported()) return;
    if (!canStart(identity)) return status('上次呼叫的结束或取消仍待服务器确认，请稍后重试。');
    const blocked = mediaBlocked(); if (blocked) return status(blocked);
    stopReason = '';
    const targetId = el('callRecipient')?.value;
    if (!members.some(member => member.id === targetId)) return status('请选择真实家庭成员。');
    if (!retryStart || retryStart.targetId !== targetId) retryStart = { targetId, requestId: crypto.randomUUID() };
    const token = identity, generation = epoch; busy = true; render(); status('正在呼叫家人…');
    try { const result = await request('callStart', retryStart, token, result => { if (!current(token, generation)) bestEffortEnd(result.callId || result.call?.id, token, 'cancelled'); }); if (current(token, generation) && dialog?.open) mediaIntent.add(result.callId || result.call?.id); await apply(result, token, generation); if (current(token, generation)) retryStart = null; }
    catch (error) { if (current(token, generation)) status(error.name === 'AbortError' ? '尚未确认呼叫结果，可重试同一次呼叫。' : error.message); }
    finally { if (current(token, generation)) { busy = false; render(); schedule(); } }
  }
  async function respond(action) {
    if (busy || !call || call.direction !== 'incoming' || call.status !== 'ringing') return;
    if (action === 'callAccept' && !canStart(identity)) return status('上次呼叫的结束或取消仍待服务器确认，请稍后重试。');
    const blocked = action === 'callAccept' && mediaBlocked(); if (blocked) return status(blocked);
    if (action === 'callAccept') mediaIntent.add(call.id);
    const token = identity, generation = epoch, id = call.id; busy = true; render();
    try { const result = await request(action, { id }, token, result => { if (action === 'callAccept' && !current(token, generation)) bestEffortEnd(result.callId || result.call?.id, token, 'cancelled'); }); await apply(result, token, generation); }
    catch (error) { if (current(token, generation)) { status(error.message); refresh(true); } }
    finally { if (current(token, generation)) { busy = false; render(); schedule(); } }
  }
  async function play(r) {
    if (!liveRun(r) || !r.remote?.getAudioTracks().some(track => track.readyState === 'live')) return;
    try { await audio.play(); if (!liveRun(r)) return; r.playing = true; el('callListen').hidden = true; connected(r); }
    catch { if (liveRun(r)) { r.playing = false; el('callListen').hidden = false; status('已收到对方音轨，浏览器尚未播放声音。请点击“收听对方声音”。'); } }
  }
  function connected(r) {
    if (!liveRun(r)) return;
    if (r.pc.connectionState === 'connected' && r.playing && r.remote?.getAudioTracks().some(track => track.readyState === 'live')) {
      clearTimeout(r.connectTimer); status('语音已连接，正在与家人通话。');
    } else status('对方已接听，正在建立音频连接…');
  }
  async function sendIce(r) {
    if (!liveRun(r) || !r.localDescriptionSent || r.sendingIce) return;
    r.sendingIce = true;
    try {
      while (liveRun(r) && (r.pendingIce.length || (r.iceComplete && !r.completeSent))) {
        const batch = r.pendingIce.slice(0, 8), complete = r.iceComplete && r.pendingIce.length <= 8;
        await request('callSignal', { id: r.id, ...(batch.length ? { candidates: batch } : {}), ...(complete ? { iceComplete: true } : {}) }, r.token);
        if (!liveRun(r)) return; r.pendingIce.splice(0, batch.length); if (complete) r.completeSent = true;
      }
    } catch { if (liveRun(r)) end('failed', '通话网络协商失败，麦克风已关闭。'); }
    finally { if (liveRun(r)) r.sendingIce = false; }
  }
  async function negotiate(r, peer) {
    if (!liveRun(r) || !r.pc || !r.local || r.negotiating) return;
    r.negotiating = true;
    try {
      if (peer?.description && !r.pc.remoteDescription) {
        const expected = call.direction === 'outgoing' ? 'answer' : 'offer';
        if (peer.description.type !== expected) throw Error('通话信令类型无效');
        await r.pc.setRemoteDescription(peer.description); if (!liveRun(r)) return;
      }
      if (call.direction === 'incoming' && r.pc.remoteDescription && !r.localDescriptionSent) {
        const description = await r.pc.createAnswer(); if (!liveRun(r)) return;
        await r.pc.setLocalDescription(description); if (!liveRun(r)) return;
        await request('callSignal', { id: r.id, description: { type: 'answer', sdp: r.pc.localDescription.sdp } }, r.token); if (!liveRun(r)) return;
        r.localDescriptionSent = true; sendIce(r);
      }
      if (r.pc.remoteDescription) {
        for (const item of (peer?.candidates || [])) {
          if (r.seen.has(item.seq)) continue;
          if (r.seen.size >= 48) throw Error('通话候选数量超限');
          await r.pc.addIceCandidate(item.candidate); if (!liveRun(r)) return; r.seen.add(item.seq);
        }
        if (peer?.iceComplete && !r.remoteComplete) { await r.pc.addIceCandidate(null); if (!liveRun(r)) return; r.remoteComplete = true; }
      }
    } catch { if (liveRun(r)) end('failed', '无法建立家人音频连接，麦克风已关闭。'); }
    finally { if (liveRun(r)) r.negotiating = false; }
  }
  async function begin(value) {
    if (!dialog?.open || document.hidden || !mediaIntent.has(value.id)) return;
    const blocked = mediaBlocked(); if (blocked) return end('failed', blocked);
    globalThis.MemoryAI?.pauseForCall(); document.querySelectorAll('audio').forEach(item => item.pause());
    if (typeof frameAudio !== 'undefined') frameAudio?.pause();
    stopReason = '';
    const r = { id: value.id, token: identity, generation: epoch, pc: null, local: null, remote: null, playing: false, seen: new Set(), pendingIce: [], localCount: 0 };
    run = r; status('对方已接听，请允许麦克风。正在建立音频连接…');
    r.connectTimer = setTimeout(() => { if (liveRun(r)) end('failed', '音频连接超时，麦克风已关闭，请重试。'); }, 45000);
    try {
      const ice = await request('callIce', { id: r.id }, r.token); if (!liveRun(r)) return;
      const blocked = mediaBlocked(); if (blocked) return end('failed', blocked);
      if (ice.iceTransportPolicy !== 'relay' || !Array.isArray(ice.iceServers) || !ice.iceServers.length || ice.expiresAt <= Date.now()) throw Error('通话中继配置不可用');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!liveRun(r)) { stream.getTracks().forEach(track => track.stop()); return; }
      const afterPermission = mediaBlocked(); if (afterPermission) { stream.getTracks().forEach(track => track.stop()); return end('failed', afterPermission); } r.local = stream;
      const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: 'relay' }); r.pc = pc;
      pc.onicecandidate = event => {
        if (!liveRun(r)) return;
        const raw = event.candidate?.toJSON ? event.candidate.toJSON() : event.candidate;
        if (!raw || raw.candidate === '') r.iceComplete = true;
        else {
          if (r.localCount >= Math.min(48, capabilities.maxCandidates || 48)) return end('failed', '通话网络候选过多，请重新呼叫。');
          r.pendingIce.push({ candidate: raw.candidate, sdpMid: raw.sdpMid, sdpMLineIndex: raw.sdpMLineIndex, ...(raw.usernameFragment ? { usernameFragment: raw.usernameFragment } : {}) }); r.localCount++;
        }
        clearTimeout(r.iceTimer); r.iceTimer = setTimeout(() => sendIce(r), 50);
      };
      pc.ontrack = event => {
        if (!liveRun(r)) { event.track.stop(); return; }
        if (event.track.kind !== 'audio') { event.track.stop(); return; }
        if (!r.remote) r.remote = new MediaStream();
        if (!r.remote.getTracks().includes(event.track)) r.remote.addTrack(event.track);
        event.track.onended = () => { if (liveRun(r)) end('failed', '对方音轨已结束。'); };
        audio.srcObject = r.remote; play(r);
      };
      pc.onconnectionstatechange = () => {
        if (!liveRun(r)) return;
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) return end('failed', '通话网络已断开，麦克风已关闭。');
        connected(r);
      };
      stream.getTracks().forEach(track => { track.onended = () => { if (liveRun(r)) end('failed', '麦克风已断开，通话已结束。'); }; pc.addTrack(track, stream); });
      if (value.direction === 'outgoing') {
        const description = await pc.createOffer(); if (!liveRun(r)) return;
        await pc.setLocalDescription(description); if (!liveRun(r)) return;
        await request('callSignal', { id: r.id, description: { type: 'offer', sdp: pc.localDescription.sdp } }, r.token); if (!liveRun(r)) return;
        r.localDescriptionSent = true; sendIce(r);
      }
      await negotiate(r, call?.peer); if (liveRun(r)) connected(r);
    } catch (error) { if (liveRun(r)) end('failed', error.name === 'NotAllowedError' ? '麦克风未获允许，通话已结束。请允许权限后重新呼叫。' : '无法开启通话音频，麦克风已关闭。'); }
  }
  async function open(targetId = '') {
    if (!auth() || document.hidden) return;
    if (identity && identity !== auth()) dispose(); identity = auth(); ensure();
    if (targetId) selected = targetId;
    if (!dialog.open) dialog.showModal(); render(); await refresh(true);
  }
  async function start(targetId, { callId } = {}) {
    if (document.hidden) { if (callId) bestEffortEnd(callId, auth(), 'cancelled'); return; }
    if (callId && unsupported()) { const token = auth(); await open(targetId); status(unsupported()); bestEffortEnd(callId, token, 'failed'); return; }
    const opening = open(targetId), openingToken = identity, openingEpoch = epoch; await opening;
    if (!callId) return;
    if (!current(openingToken, openingEpoch) || document.hidden || !dialog?.open || (call && call.id !== callId)) { bestEffortEnd(callId, openingToken, 'cancelled'); return; }
    mediaIntent.add(callId);
    const token = identity, generation = epoch;
    try { const result = await request('callState', { id: callId }, token); if (!current(token, generation) || document.hidden || !dialog?.open) { bestEffortEnd(callId, token, 'cancelled'); return; } await apply(result, token, generation); schedule(); }
    catch (error) { bestEffortEnd(callId, token, 'cancelled'); if (current(token, generation)) status(pendingMessage); }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { end('hangup', '页面已切到后台，通话与麦克风已关闭。'); dialog?.close(); } });
  globalThis.addEventListener('offline', () => { if (call || retryStart || run) end('failed', '网络已断开，本机通话与麦克风已关闭。'); });
  globalThis.addEventListener('pagehide', dispose);
  return { busy: () => Boolean(dialog?.open || busy || run || (call && LIVE.has(call.status))), open, dispose, refresh, start, cancelStart, hasPendingCancellations, canStart, supported: () => !unsupported() };
})();
