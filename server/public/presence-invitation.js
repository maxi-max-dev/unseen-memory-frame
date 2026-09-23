'use strict';
// Cloud presence is an invitation only. It never accesses a camera or microphone.
globalThis.MemoryPresence = (() => {
  let invitation = null, guardTimer = null;
  const seenInPage = new Map();
  const valid = event => event && event.type === 'presence.dwell'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.eventId)
    && Number.isSafeInteger(event.seq) && event.seq > 0
    && Number.isSafeInteger(event.receivedAt) && Number.isSafeInteger(event.expiresAt)
    && event.expiresAt > event.receivedAt && event.expiresAt - event.receivedAt <= 15000;
  const log = (event, outcome, reason) => console.info('[presence]', {
    eventId: event.eventId, seq: event.seq, outcome, ...(reason ? { reason } : {})
  });
  // Full request RTT is a conservative upper bound on time in transit. Adding it
  // prevents a slow state response from granting an already expired event a new TTL.
  function serverNow() {
    return Number.isFinite(state?.serverTime) && Number.isFinite(stateReceivedAt)
      ? state.serverTime + Math.max(0, typeof stateRoundTripMs === 'number' ? stateRoundTripMs : 0) + Math.max(0, performance.now() - stateReceivedAt) : Date.now();
  }
  function gate(fixedPhoto) {
    if (!frame || location.pathname !== '/frame' || session?.role !== 'frame') return 'wrong-page';
    if (!session?.token || sessionExpired || authScreenActive) return 'session';
    if (document.hidden || document.documentElement.classList.contains('night-view')) return 'hidden';
    if (recording || recordingStarting || sending) return 'recording';
    if ((frameAudio && !frameAudio.paused && !frameAudio.ended)
      || [...document.querySelectorAll('audio')].some(audio => !audio.paused && !audio.ended)) return 'audio';
    if (globalThis.MemoryRealtime?.busy() || globalThis.MemoryAI?.busy()
      || globalThis.MemoryCall?.busy?.() || globalThis.speechSynthesis?.speaking) return 'conversation';
    if ([...document.querySelectorAll('dialog[open]')].some(dialog => dialog !== invitation?.dialog)) return 'dialog';
    const photo = fixedPhoto ? state?.messages.find(message => message._id === fixedPhoto) : current();
    if (!photo || photo.deleted || photo.type !== 'photo' || !photo.image || !photo.imageURL) return 'no-photo';
    if (typeof globalThis.MemoryAI?.open !== 'function') return 'ai-unavailable';
    return '';
  }
  function close(reason = 'closed') {
    const previous = invitation; invitation = null;
    clearInterval(guardTimer); guardTimer = null;
    if (!previous) return;
    previous.dialog.close(); previous.dialog.remove();
    log(previous.event, 'closed', reason);
    if (['declined', 'accepted'].includes(reason) && previous.focus?.isConnected) previous.focus.focus?.({ preventScroll: true });
  }
  function guard() {
    if (!invitation) return;
    if (invitation.token !== session?.token) return close('session');
    if (serverNow() >= invitation.event.expiresAt) return close('expired');
    const reason = gate(invitation.photoId);
    if (reason) close(reason);
  }
  function consume(event) {
    const storageKey = 'memory-presence-seen-v1:' + session.room;
    let stored;
    try { stored = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return 'storage-unavailable'; }
    const previous = seenInPage.get(storageKey);
    if ([stored, previous].some(value => value && (value.seq >= event.seq || value.eventId === event.eventId))) return 'duplicate';
    // Persist before checking visibility/busy gates: ignored events are never queued.
    const value = { seq: event.seq, eventId: event.eventId };
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { return 'storage-unavailable'; }
    seenInPage.set(storageKey, value);
    return '';
  }
  function show(event) {
    const dialog = document.createElement('dialog');
    dialog.id = 'presenceInvitation'; dialog.className = 'presence-invitation';
    dialog.setAttribute('aria-labelledby', 'presenceInvitationTitle');
    dialog.setAttribute('aria-describedby', 'presenceInvitationNote');
    dialog.innerHTML = '<p class="presence-eyebrow">一起聊聊家里的记忆</p><h2 id="presenceInvitationTitle">想聊聊这张照片吗？</h2><p id="presenceInvitationNote">可以和 AI 慢慢聊。由您决定是否开始。</p><div class="presence-invitation-actions"><button id="presenceAccept" class="primary" type="button">和 AI 聊聊</button><button id="presenceDecline" type="button" autofocus>暂时不用</button></div>';
    invitation = { event, photoId: current()._id, token: session.token, dialog, focus: document.activeElement };
    document.body.append(dialog);
    dialog.querySelector('#presenceDecline').onclick = () => close('declined');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close('declined'); });
    dialog.querySelector('#presenceAccept').onclick = async () => {
      guard(); const accepted = invitation; if (!accepted) return;
      close('accepted'); log(accepted.event, 'accepted');
      try {
        await globalThis.MemoryAI.open(accepted.photoId);
        // open() also checks the session; a closed/cancelled dialog is not success.
        log(accepted.event, document.querySelector('.ai-dialog[open]') && session?.token === accepted.token && !sessionExpired ? 'ai-opened' : 'ai-not-opened');
      } catch { log(accepted.event, 'ai-open-failed'); toast('暂时未能打开 AI 聊天，请稍后再试'); }
    };
    dialog.showModal(); log(event, 'shown');
    guardTimer = setInterval(guard, 200);
  }
  function receive(event) {
    if (!frame || session?.role !== 'frame' || !session?.token || sessionExpired || authScreenActive) { close('session'); return; }
    guard();
    if (!event) { close('unavailable'); return; }
    if (!valid(event)) return;
    const consumed = consume(event);
    if (consumed) { log(event, consumed === 'duplicate' ? 'duplicate' : 'ignored', consumed === 'duplicate' ? undefined : consumed); return; }
    log(event, 'received');
    if (event.expiresAt <= serverNow() || event.receivedAt > serverNow() + 1000) { log(event, 'expired'); return; }
    const reason = invitation ? 'invitation' : gate();
    if (reason) { log(event, 'ignored', reason); return; }
    show(event);
  }
  document.addEventListener('visibilitychange', guard);
  document.addEventListener('play', guard, true);
  globalThis.addEventListener('pagehide', () => close('pagehide'));
  return { receive, close, guard };
})();
