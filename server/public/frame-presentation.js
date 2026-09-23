'use strict';
globalThis.MemoryFramePresentation = (() => {
  const PERIOD = 15000;
  let mounted = '', presenting = false, cycling = false, timer = null, deadline = 0, fullscreenOwned = false, fullscreenPending = false, generation = 0, suspendedNight = null;
  const node = id => document.getElementById(id);
  const valid = () => frame && mounted && session?.token === mounted && !sessionExpired && !authScreenActive;
  function busy() {
    return document.hidden || document.documentElement.classList.contains('night-view')
      || recording || recordingStarting || sending || !!draft.audio
      || (frameAudio && !frameAudio.paused && !frameAudio.ended)
      || [...document.querySelectorAll('audio')].some(audio => !audio.paused && !audio.ended)
      || globalThis.MemoryAI?.busy() || globalThis.MemoryRealtime?.busy() || globalThis.MemoryCall?.busy?.()
      || globalThis.speechSynthesis?.speaking || !!document.querySelector('dialog[open]') || !!node('frameMenu')?.open;
  }
  function resetCycle() { deadline = performance.now() + PERIOD; }
  function restoreNight() {
    if (suspendedNight === null) return;
    localDisplay.night = suspendedNight; suspendedNight = null; applyLocalDisplay();
  }
  function refresh() {
    if (!mounted) return;
    if (!valid()) return dispose();
    const count = photos().length, paused = busy();
    if (node('frameFullscreen')) node('frameFullscreen').disabled = fullscreenPending;
    if (paused || count < 2) resetCycle();
    for (const id of ['prev', 'next']) if (node(id)) node(id).disabled = count < 2 || !!paused;
    const toggle = node('frameSlideshow');
    if (toggle) { toggle.disabled = count < 2; toggle.textContent = cycling ? '停止轮播' : '开启轮播'; toggle.setAttribute('aria-pressed', String(cycling)); }
    const status = node('frameSlideshowStatus');
    if (status) status.textContent = count < 2 ? '两张以上可轮播' : cycling ? paused ? '轮播已暂停 · 当前操作结束后继续' : '每 15 秒换一张' : '轮播已关闭';
    const spaceNote = node('frameSpatialNote');
    if (spaceNote) spaceNote.textContent = current()?.spatial?.status === 'ready' ? '这份记忆有可观看的空间。' : '当前照片没有可观看的空间，可从下面选择；新空间请家人在手机端导入。';
    const choices = node('frameSpatialChoices');
    if (choices) {
      const available = (state?.messages || []).filter(message => message.spatial?.status === 'ready' && message._id !== current()?._id);
      const signature = JSON.stringify([current()?._id, current()?.spatial?.status, available.map(message => [message._id, message.title, message.spatial.sourceTitle])]);
      if (choices.dataset.signature !== signature) {
        choices.dataset.signature = signature; choices.replaceChildren();
        for (const message of available) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = '走进空间 · ' + (message.spatial.sourceTitle || message.title || '家里的空间');
          button.onclick = () => { node('frameMenu').open = false; showSpatialViewer(message._id); };
          choices.append(button);
        }
        if (!available.length && current()?.spatial?.status !== 'ready') choices.textContent = '家里还没有其他已准备好的空间。';
      }
    }
  }
  function tick() {
    if (!valid()) return dispose();
    refresh();
    if (cycling && !busy() && photos().length > 1 && performance.now() >= deadline) { resetCycle(); move(1); }
  }
  function toggleCycle() {
    if (!valid() || photos().length < 2) return;
    cycling = !cycling; clearInterval(timer); timer = null; resetCycle();
    if (cycling) timer = setInterval(tick, 250);
    refresh();
  }
  function exit() {
    generation++; presenting = false; cycling = false; clearInterval(timer); timer = null;
    document.body.classList.remove('frame-presenting');
    restoreNight();
    if (fullscreenOwned && document.fullscreenElement === document.documentElement) document.exitFullscreen?.().catch(() => {});
    fullscreenOwned = false;
    if (node('framePresentation')) { node('framePresentation').textContent = '放大相框'; node('framePresentation').setAttribute('aria-pressed', 'false'); }
    if (node('frameFullscreen')) node('frameFullscreen').hidden = true;
    refresh();
  }
  function enter() {
    if (!valid()) return;
    // Keep this explicit display session visible across the night-clock boundary.
    // Do not persist this temporary override of the device preference.
    if (typeof localDisplay !== 'undefined' && localDisplay.night) { suspendedNight = localDisplay.night; localDisplay.night = false; applyLocalDisplay(); }
    if (busy()) { restoreNight(); return; }
    presenting = true; generation++; resetCycle();
    document.body.classList.add('frame-presenting');
    node('framePresentation').textContent = '退出展示'; node('framePresentation').setAttribute('aria-pressed', 'true');
    node('frameFullscreen').hidden = !document.documentElement.requestFullscreen;
    node('framePresentation').focus({ preventScroll: true });
  }
  async function fullscreen() {
    if (!valid() || !presenting || fullscreenPending || !document.documentElement.requestFullscreen) return;
    const request = generation;
    fullscreenPending = true; node('frameFullscreen').disabled = true;
    try {
      fullscreenOwned = true; await document.documentElement.requestFullscreen();
      if (!valid() || !presenting || generation !== request) { fullscreenOwned = false; if (document.fullscreenElement === document.documentElement) await document.exitFullscreen(); }
    } catch { fullscreenOwned = false; if (presenting) node('frameSlideshowStatus').textContent = '已使用页面展示模式；浏览器全屏不可用。'; }
    finally { fullscreenPending = false; if (node('frameFullscreen')) node('frameFullscreen').disabled = false; }
  }
  function mount() {
    if (!frame || !session || sessionExpired) return; mounted = session.token;
    const toolbar = document.createElement('div'); toolbar.id = 'framePresentationControls'; toolbar.className = 'frame-presentation-tools';
    toolbar.innerHTML = '<button id="framePresentation" type="button" aria-pressed="false">放大相框</button><button id="frameSlideshow" type="button" aria-pressed="false">开启轮播</button><button id="frameFullscreen" type="button" hidden>浏览器全屏</button><small id="frameSlideshowStatus" role="status">轮播已关闭</small>';
    node('app').querySelector('.elder-stage').before(toolbar);
    node('framePresentation').onclick = () => presenting ? exit() : enter(); node('frameSlideshow').onclick = toggleCycle; node('frameFullscreen').onclick = fullscreen;
    node('prev').textContent = '‹'; node('next').textContent = '›';
    const menu = node('frameMenu').querySelector('.frame-menu-items');
    const intro = document.createElement('p'); intro.className = 'frame-more-intro'; intro.textContent = '相框里的更多陪伴'; menu.prepend(intro);
    const ai = node('aiHomeEntry'); if (ai) { menu.append(ai); node('aiHomeChat').textContent = '围绕当前照片聊'; node('aiHomeChat').onclick = () => { node('frameMenu').open = false; globalThis.MemoryAI?.open(current()?._id); }; node('aiHomeLive').textContent = 'AI 实时语音 · 查看可用性'; }
    node('openAI').hidden = true;
    node('openContact').textContent = '联系家人 · 站内提醒';
    const note = document.createElement('p'); note.className = 'frame-contact-note'; note.textContent = '联系请求会在家人打开页面时提醒，不会拨打电话。AI 实时语音需服务已开通。'; menu.append(note);
    const spaces = document.createElement('section'); spaces.id = 'frameSpaces'; spaces.innerHTML = '<h3>走进家里的空间</h3><p id="frameSpatialNote"></p><div id="frameSpatialChoices"></div>';
    spaces.append(node('currentSpatial')); menu.append(spaces);
    const display = document.createElement('p'); display.className = 'frame-contact-note'; display.textContent = '字号、夜间时钟、设备状态与重新配对请打开“设置”。'; menu.append(display);
    node('frameMenu').ontoggle = refresh;
    resetCycle(); refresh();
  }
  function dispose() {
    mounted = ''; exit(); node('framePresentationControls')?.remove();
    // The shared menu survives shell rebuilds; retain only existing action buttons.
    node('frameMenu')?.querySelectorAll('.frame-more-intro,.frame-contact-note,#frameSpaces,#aiHomeEntry').forEach(element => element.remove());
  }
  document.addEventListener('visibilitychange', () => { resetCycle(); refresh(); });
  document.addEventListener('play', () => { resetCycle(); refresh(); }, true);
  document.addEventListener('pause', () => { resetCycle(); refresh(); }, true);
  new MutationObserver(() => { resetCycle(); refresh(); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  document.addEventListener('fullscreenchange', () => { if (fullscreenOwned && !document.fullscreenElement) exit(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && presenting && !document.querySelector('dialog[open]')) { event.preventDefault(); exit(); } });
  globalThis.addEventListener('pagehide', dispose);
  return { mount, refresh, busy, resetCycle, exit, dispose };
})();
