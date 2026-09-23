'use strict';
globalThis.MemoryRealtime = (() => {
  let panel = null, currentClient = null, focusOrigin = null, openEpoch = 0, capabilityController = null;
  const pendingStops = new Map();
  const supported = () => globalThis.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!globalThis.RTCPeerConnection;
  // The transport is injectable for lifecycle tests, not selected by API input.
  function createClient({ request, loadSDK = () => import('/vendor/trtc-5.19.2.mjs').then(m => m.default),
    acquire = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }),
    permitted = () => !document.hidden, onState = () => {}, stopState = {} } = {}) {
    let active = null, generation = 0, stopping = false;
    stopState.listeners ||= new Set(); stopState.listeners.add(onState);
    const emitStop = value => { for (const listener of stopState.listeners) listener(value); };
    const live = run => active === run && run.generation === generation && permitted();
    function release(run) {
      if (!run) return;
      clearTimeout(run.connectTimer); clearTimeout(run.remoteTimer); clearTimeout(run.heartbeatTimer); clearTimeout(run.expiryTimer);
      run.controller.abort(); run.stream?.getTracks().forEach(track => track.stop());
      // Mute/destroy immediately, including when enterRoom/startLocalAudio is pending.
      try { Promise.resolve(run.trtc?.muteRemoteAudio('*', true)).catch(() => {}); } catch {}
      try { Promise.resolve(run.trtc?.stopLocalAudio()).catch(() => {}); } catch {}
      try { Promise.resolve(run.trtc?.exitRoom()).catch(() => {}); } catch {}
      try { run.trtc?.destroy(); } catch {}
    }
    async function stop(message = '已挂断，麦克风已关闭。') {
      if (stopping || stopState.inFlight) return;
      const run = active || stopState.run; active = null; generation++; release(run);
      stopping = Boolean(run?.requested);
      emitStop({ phase: stopping ? 'stopping' : 'idle', message: stopping ? `${message} 正在确认对话已结束…` : message });
      const stoppedGeneration = generation;
      if (!run || !run.requested) return;
      stopState.run = run; stopState.inFlight = true;
      let confirmed = false;
      try {
        const result = await request('aiRealtimeStop', { requestId: run.id }, { keepalive: true });
        confirmed = result.status === 'ended';
        if (!confirmed) message = '麦克风已关闭，远端对话结束尚未确认。请点“确认已结束”重试。';
      } catch { message = '麦克风已关闭，网络中断使远端对话结束尚未确认。'; }
      finally {
        stopState.inFlight = false;
        if (confirmed) delete stopState.run;
        if (!active && generation === stoppedGeneration) { stopping = false; emitStop({ phase: confirmed ? 'idle' : 'stop-pending', message }); }
      }
    }
    function abandon(run) { if (active === run) void stop('已停止，麦克风已关闭。'); else release(run); }
    async function heartbeat(run) {
      if (!live(run)) return stop('已停止，麦克风已关闭。');
      try {
        const result = await request('aiRealtimeStatus', { requestId: run.id }, { signal: run.controller.signal });
        if (!live(run)) return;
        if (result.status !== 'active') return stop('这段实时对话已结束，麦克风已关闭。');
        run.heartbeatTimer = setTimeout(() => heartbeat(run), 10000);
      } catch { if (live(run)) void stop('实时连接中断，已关闭麦克风。请重新开始。'); }
    }
    async function start() {
      if (active || stopping || stopState.run || !permitted()) return;
      const run = { id: crypto.randomUUID(), generation: ++generation, controller: new AbortController(), muted: false, requested: false };
      active = run; onState({ phase: 'connecting', message: '请允许麦克风，正在连接实时语音…' });
      run.connectTimer = setTimeout(() => { if (live(run)) void stop('连接超时，麦克风已关闭。请重试。'); }, 45000);
      try {
        // Called directly from the Start button; no camera/person event can call it.
        const stream = await acquire(); run.stream = stream;
        if (!live(run)) { abandon(run); return; }
        for (const track of stream.getAudioTracks()) track.onended = () => { if (live(run)) void stop('麦克风已断开，请重新开始。'); };
        const TRTC = await loadSDK(); if (!live(run)) { abandon(run); return; }
        TRTC.setLogLevel?.(5, false); // NONE; no SDK credentials/diagnostic uploads
        run.trtc = TRTC.create();
        run.trtc.on(TRTC.EVENT.ERROR, () => { if (live(run)) void stop('实时音频出错，已关闭麦克风。'); });
        run.trtc.on(TRTC.EVENT.KICKED_OUT, () => { if (live(run)) void stop('实时连接已结束，请重新开始。'); });
        run.trtc.on(TRTC.EVENT.AUTOPLAY_FAILED, () => { if (live(run)) void stop('浏览器未允许播放语音，请允许声音后重新开始。'); });
        run.trtc.on(TRTC.EVENT.CONNECTION_STATE_CHANGED, event => { if (live(run) && event.state === 'DISCONNECTED') void stop('实时连接已断开，麦克风已关闭。'); });
        run.requested = true;
        const result = await request('aiRealtimeStart', { requestId: run.id }, { signal: run.controller.signal });
        if (!live(run)) { abandon(run); void request('aiRealtimeStop', { requestId: run.id }, { keepalive: true }).catch(() => {}); return; }
        if (result.status !== 'active' || result.provider !== 'tencent-trtc' || !result.connection) throw Error('session unavailable');
        run.expiryTimer = setTimeout(() => { if (live(run)) void stop('本次已聊满 10 分钟。需要时可以重新开始。'); }, Math.max(1, Math.min(600000, result.expiresAt - Date.now())));
        run.heartbeatTimer = setTimeout(() => heartbeat(run), 10000);
        const { sdkAppId, userId, strRoomId, userSig, privateMapKey, agentId } = result.connection;
        const ready = () => {
          if (!live(run) || !run.published || !run.remoteReady || run.phase === 'connected') return;
          clearTimeout(run.remoteTimer);
          run.phase = 'connected'; onState({ phase: 'connected', muted: run.muted, message: run.muted ? 'AI 语音已接通。麦克风已静音，你仍可以听 AI。' : 'AI 语音已接通，可以直接说话。AI 说话时也可以开口打断。' });
        };
        run.trtc.on(TRTC.EVENT.REMOTE_AUDIO_AVAILABLE, event => {
          if (live(run) && event.userId === agentId) Promise.resolve(run.trtc.muteRemoteAudio(agentId, false)).then(() => { if (live(run)) { run.remoteReady = true; ready(); } }).catch(() => { if (live(run)) void stop('无法播放实时语音，请重试。'); });
        });
        run.trtc.on(TRTC.EVENT.REMOTE_USER_EXIT, event => { if (live(run) && event.userId === agentId) void stop('AI 已结束对话，麦克风已关闭。'); });
        await run.trtc.enterRoom({ sdkAppId, userId, userSig, privateMapKey, strRoomId, scene: 'rtc', autoReceiveVideo: false, autoReceiveAudio: false });
        if (!live(run)) { abandon(run); return; }
        await run.trtc.startLocalAudio({ option: { audioTrack: stream.getAudioTracks()[0], profile: 'standard' } });
        if (!live(run)) { abandon(run); return; }
        clearTimeout(run.connectTimer);
        run.published = true; run.phase = 'waiting';
        onState({ phase: 'waiting', message: '麦克风已开启，正在等待 AI 语音接通…' });
        run.remoteTimer = setTimeout(() => { if (live(run)) void stop('暂时没有接通 AI 语音，麦克风已关闭。请稍后重试。'); }, 30000);
        ready();
      } catch (error) {
        if (!live(run)) { abandon(run); return; }
        const message = error.name === 'NotAllowedError' ? '未获得麦克风权限，请在浏览器中允许后重试。'
          : error.name === 'NotFoundError' ? '没有找到麦克风，请连接麦克风后重试。'
          : error.name === 'NotReadableError' ? '麦克风暂时无法使用，请检查是否被其他应用占用。'
          : error.status === 401 ? '登录已失效，请关闭窗口后重新登录。'
          : error.status === 429 ? '实时对话暂时繁忙，请稍后重试，或先用文字聊天。'
          : '实时语音暂时连接不上，请检查网络后重试，或先用文字聊天。';
        await stop(message + ' 麦克风已关闭。');
      }
    }
    async function mute() {
      const run = active; if (!run || !['waiting', 'connected'].includes(run.phase) || run.muting) return;
      run.muting = true; const value = !run.muted;
      // Disable the actual track synchronously, even if SDK update stalls.
      run.stream?.getAudioTracks().forEach(track => { track.enabled = !value; });
      try { await run.trtc.updateLocalAudio({ mute: value }); if (live(run)) { run.muted = value; onState({ phase: run.phase, muted: value, message: run.phase === 'waiting' ? (value ? '麦克风已静音，正在等待 AI 语音接通…' : '麦克风已开启，正在等待 AI 语音接通…') : value ? '麦克风已静音，你仍可以听 AI。' : '麦克风已开启，可以继续说话。' }); } }
      catch { if (live(run)) void stop('麦克风状态更新失败，已结束对话。'); }
      finally { run.muting = false; }
    }
    return { start, stop, mute, busy: () => !!active || !!stopState.run, pending: () => !!stopState.run, detach: () => stopState.listeners.delete(onState) };
  }
  const element = id => panel?.querySelector('#' + id);
  function dispose() {
    openEpoch++; capabilityController?.abort(); capabilityController = null;
    const old = currentClient; currentClient = null; old?.detach(); void old?.stop(); panel?.close(); panel?.remove(); panel = null;
  }
  async function open() {
    if (!session || sessionExpired) return toast('请先登录家庭');
    if (recording) return toast('请先结束正在录给家人的原声');
    const origin = document.activeElement, resumeText = globalThis.MemoryAI?.suspendForRealtime() || false;
    dispose(); focusOrigin = origin;
    const token = session.token, epoch = ++openEpoch;
    panel = document.createElement('dialog'); panel.className = 'ai-dialog ai-realtime-dialog'; panel.setAttribute('aria-labelledby', 'aiRealtimeTitle');
    panel.innerHTML = '<div class="row between ai-dialog-heading"><h2 id="aiRealtimeTitle">和 AI 实时聊聊</h2><button id="realtimeClose" type="button" aria-label="关闭实时语音">关闭 ×</button></div><p>连接后可以像电话一样边听边说，开口打断 AI。</p><p id="realtimeAvailability" class="ai-realtime-note" role="status">正在检查实时语音是否可用…</p><p class="muted">点击开始后才会使用麦克风。声音将交给实时语音服务处理；本应用不保存通话录音，也不会自动给家人发送留言。</p><div class="row"><button id="realtimeStart" aria-describedby="realtimeAvailability realtimeStatus" class="primary" type="button" disabled>开始实时对话</button><button id="realtimeMute" type="button" aria-pressed="false" disabled>麦克风静音</button><button id="realtimeEnd" class="red" type="button" disabled>挂断</button></div><p id="realtimeStatus" role="status" aria-live="polite">麦克风未开启</p><button id="realtimeText" type="button">先用文字和 AI 聊聊</button><p class="muted">离开页面、切到后台、关闭窗口会结束对话。每次最多 10 分钟。语音不会继承文字聊天或照片内容。</p>';
    document.body.append(panel); panel.showModal();
    const current = () => panel?.open && openEpoch === epoch && session?.token === token && !sessionExpired;
    const valid = () => current() && !document.hidden;
    let enabled = false;
    if (!pendingStops.has(token)) pendingStops.set(token, {});
    const client = createClient({
      stopState: pendingStops.get(token),
      permitted: valid,
      request: async (action, data, opts = {}) => {
        // Keepalive lets an authorized stop finish while the page is leaving.
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), action === 'aiRealtimeStart' ? 35000 : 12000);
        const abort = () => controller.abort(); opts.signal?.addEventListener('abort', abort, { once: true });
        if (opts.signal?.aborted) controller.abort();
        try {
          const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ action, data }), signal: controller.signal, keepalive: !!opts.keepalive });
          const result = await response.json(); if (!response.ok) throw Object.assign(Error('实时服务请求失败'), { status: response.status }); return result;
        } finally { clearTimeout(timeout); opts.signal?.removeEventListener('abort', abort); }
      },
      onState({ phase, message, muted = false }) {
        if (openEpoch !== epoch || !panel) return;
        const focused = document.activeElement;
        element('realtimeStatus').textContent = message;
        element('realtimeStart').disabled = !enabled || phase !== 'idle';
        element('realtimeStart').textContent = ['connecting', 'waiting'].includes(phase) ? '正在连接…' : phase === 'stopping' ? '正在挂断…' : phase === 'stop-pending' ? '等待结束确认' : '开始实时对话';
        element('realtimeEnd').disabled = !['connecting', 'waiting', 'connected'].includes(phase); element('realtimeMute').disabled = !['waiting', 'connected'].includes(phase);
        element('realtimeRetryStop').hidden = phase !== 'stop-pending';
        element('realtimeMute').textContent = muted ? '打开麦克风' : '麦克风静音'; element('realtimeMute').setAttribute('aria-pressed', String(muted));
        if (focused?.disabled && valid()) (['connecting', 'waiting', 'connected'].includes(phase) ? element('realtimeEnd') : phase === 'stop-pending' ? element('realtimeRetryStop') : phase === 'idle' && enabled ? element('realtimeStart') : element('realtimeText')).focus?.({ preventScroll: true });
      }
    });
    currentClient = client;
    const retryStop = document.createElement('button'); retryStop.id = 'realtimeRetryStop'; retryStop.type = 'button'; retryStop.textContent = '确认已结束'; retryStop.hidden = !client.pending();
    element('realtimeStatus').after(retryStop); retryStop.onclick = () => client.stop();
    if (client.pending()) element('realtimeStatus').textContent = '麦克风已关闭，上次对话结束尚未确认。请点“确认已结束”。';
    const close = () => { const origin = focusOrigin; dispose(); if (resumeText) void globalThis.MemoryAI?.resume(); else if (origin?.isConnected && !origin.hidden) origin.focus?.({ preventScroll: true }); };
    element('realtimeClose').onclick = close; panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    element('realtimeText').textContent = resumeText ? '返回文字聊天（内容已保留）' : '先用文字和 AI 聊聊';
    element('realtimeText').onclick = () => { const origin = focusOrigin; dispose(); if (!resumeText && origin?.isConnected) origin.focus?.({ preventScroll: true }); void globalThis.MemoryAI?.resume(); };
    element('realtimeStart').onclick = () => { if (enabled && valid()) { globalThis.speechSynthesis?.cancel(); document.querySelectorAll('audio').forEach(audio => audio.pause()); void client.start(); } };
    element('realtimeEnd').onclick = () => client.stop(); element('realtimeMute').onclick = () => client.mute();
    const capRequest = new AbortController(); capabilityController = capRequest;
    const timer = setTimeout(() => capRequest.abort(), 12000);
    try {
      const caps = await api('aiRealtimeCapabilities', {}, token, { signal: capRequest.signal }); if (!current()) return;
      enabled = caps.enabled === true && caps.provider === 'tencent-trtc' && supported();
      element('realtimeAvailability').textContent = !caps.enabled ? '实时语音尚未开通，可以先用文字和 AI 聊聊。' : caps.provider !== 'tencent-trtc' ? '实时语音暂不可用，可以先使用文字聊天。' : !supported() ? '当前浏览器无法使用实时语音，请用支持麦克风的浏览器打开安全连接。' : '可以尝试连接实时语音。点击开始并连接成功后才能交谈。';
      element('realtimeStart').disabled = !enabled || client.busy();
    } catch { if (current()) element('realtimeAvailability').textContent = '暂时无法检查实时语音。可以先使用文字聊天，稍后重新打开。'; }
    finally { clearTimeout(timer); }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) void currentClient?.stop('页面已切到后台，实时对话和麦克风已关闭。'); });
  globalThis.addEventListener('pagehide', dispose);
  return { open, dispose, createClient, busy: () => currentClient?.busy() || (typeof session !== 'undefined' && !!pendingStops.get(session?.token)?.run) || false };
})();
