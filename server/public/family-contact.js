'use strict';
(() => {
  let dialog, content, notice, snapshot, loadedToken = '', epoch = 0, busy = false, checking = false, lastCheck = 0, retryRequest;
  const controllers = new Set();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => typeof session !== 'undefined' && !sessionExpired ? session?.token || '' : '';
  const current = (value, generation) => value && value === token() && generation === epoch;

  function ensure() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.id = 'familyContactDialog'; dialog.setAttribute('aria-labelledby', 'familyContactTitle');
    dialog.innerHTML = '<div class="contact-heading"><h2 id="familyContactTitle">联系家人</h2><button type="button" data-close aria-label="关闭家庭联系">关闭</button></div><p class="contact-description">给家人发一条站内联系请求，对方可以确认收到。双方需打开相框页面查看；这里暂不提供语音或视频通话。</p><div class="contact-status" role="status" aria-live="polite"></div><div data-content></div>';
    document.body.append(dialog); content = dialog.querySelector('[data-content]');
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { if (dialog.open) return; epoch++; for (const controller of controllers) controller.abort(); controllers.clear(); busy = false; checking = false; lastCheck = 0; render(); });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]'); if (!button || busy) return;
      if (button.dataset.action === 'request') {
        const targetId = dialog.querySelector('select')?.value; if (!targetId) return;
        if (!retryRequest || retryRequest.targetId !== targetId) retryRequest = { targetId, requestId: crypto.randomUUID() };
        mutate('contactRequest', retryRequest);
      } else if (button.dataset.action === 'end') mutate('contactEnd', { id: button.dataset.id });
      else mutate('contactRespond', { id: button.dataset.id, response: button.dataset.action });
    });
    notice = document.createElement('button'); notice.id = 'familyContactNotice'; notice.type = 'button'; notice.hidden = true; notice.setAttribute('aria-live', 'polite'); notice.onclick = open; document.body.append(notice);
  }

  function status(message, error = false) {
    if (!dialog) return;
    const el = dialog.querySelector('.contact-status'); el.textContent = message; el.dataset.error = String(error);
  }

  function render() {
    if (!dialog || !snapshot) return;
    const previous = dialog.querySelector('select')?.value;
    const focused = dialog.contains(document.activeElement) ? { action: document.activeElement.dataset?.action, id: document.activeElement.dataset?.id, select: document.activeElement.tagName === 'SELECT' } : null;
    const members = snapshot.members || [], requests = snapshot.requests || [];
    content.innerHTML = `<div class="contact-compose"><label>选择家庭成员<select aria-label="选择家庭成员" ${busy || !members.length ? 'disabled' : ''}>${members.map(member => `<option value="${escape(member.id)}">${escape(member.name)}${member.role === 'frame' ? '（相框）' : ''} · ${escape(member.id.slice(-6))} · ${member.recentlySeen ? '最近打开过页面' : '可能未打开页面'}</option>`).join('')}</select></label><button type="button" class="primary" data-action="request" ${busy || !members.length ? 'disabled' : ''}>发送联系请求</button></div>${!members.length ? '<p>暂时没有其他有效登录的家庭成员，请先邀请家人加入或配对相框。</p>' : ''}<div aria-label="最近的联系请求">${requests.length ? requests.map(item => {
      const incoming = item.direction === 'incoming', name = incoming ? item.from.name : item.to.name;
      const labels = { pending: incoming ? '想联系你，等待你的回应' : '请求已保存，等待对方回应', acknowledged: incoming ? '你已确认收到，可通过双方已有联系方式继续联系' : '对方已确认收到，可通过双方已有联系方式继续联系', declined: incoming ? '你已婉拒' : '对方暂时不方便', cancelled: '发起者已取消', ended: '此次联系已结束', expired: '请求已过期', unavailable: '成员登录已失效或已离开家庭' };
      const actions = item.status === 'pending' ? incoming ? `<button type="button" data-action="acknowledge" data-id="${escape(item.id)}">确认收到</button><button type="button" data-action="decline" data-id="${escape(item.id)}">暂不方便</button>` : `<button type="button" data-action="end" data-id="${escape(item.id)}">取消请求</button>` : item.status === 'acknowledged' ? `<button type="button" data-action="end" data-id="${escape(item.id)}">结束此次联系</button>` : '';
      return `<section class="contact-record"><b>${incoming ? '来自' : '联系'} ${escape(name)}</b><p>${escape(labels[item.status] || '状态待确认')}</p><small>${escape(new Date(item.createdAt).toLocaleString('zh-CN'))}${item.status === 'pending' ? ' · 5 分钟内有效' : ''}</small>${actions ? `<div class="contact-actions">${actions}</div>` : ''}</section>`;
    }).join('') : '<p>还没有联系请求。</p>'}</div>`;
    if (previous && members.some(member => member.id === previous)) dialog.querySelector('select').value = previous;
    if (busy) content.querySelectorAll('button').forEach(button => { button.disabled = true; });
    if (focused?.select) dialog.querySelector('select')?.focus({ preventScroll: true });
    else if (focused?.action) [...content.querySelectorAll('button')].find(button => button.dataset.action === focused.action && button.dataset.id === focused.id)?.focus({ preventScroll: true });
    notice.hidden = !snapshot.incomingCount || dialog.open;
    notice.textContent = snapshot.incomingCount ? `家人想联系你 · ${snapshot.incomingCount} 条待回应` : '';
  }

  async function request(action, data, auth) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try { return await api(action, data, auth, { signal: controller.signal }); }
    finally { clearTimeout(timer); controllers.delete(controller); }
  }

  async function refresh(force = false) {
    const auth = token();
    if (!auth) { dispose(); return; }
    if (loadedToken && loadedToken !== auth) dispose();
    loadedToken = auth; ensure();
    if (checking || busy || (!force && Date.now() - lastCheck < 5000) || (!force && document.hidden)) return;
    const generation = epoch; checking = true; lastCheck = Date.now();
    try {
      const result = await request('contactState', {}, auth);
      if (!current(auth, generation)) return;
      snapshot = result; render(); if (dialog.open) status('联系请求仅在本页面内提醒。');
    } catch (error) {
      if (current(auth, generation) && dialog.open) status(error.name === 'AbortError' ? '读取超时，请关闭后重新打开。' : error.message, true);
    } finally { if (generation === epoch) checking = false; }
  }

  async function mutate(action, data) {
    const auth = token(); if (!auth || busy) return;
    // A state response started before this action cannot overwrite its newer result.
    epoch++; for (const controller of controllers) controller.abort(); controllers.clear(); checking = false;
    const generation = epoch;
    busy = true; render(); status('正在保存…');
    try {
      const result = await request(action, data, auth);
      if (!current(auth, generation)) return;
      snapshot = result; if (action === 'contactRequest') retryRequest = null;
      status(action === 'contactRequest' ? '请求已保存，等待对方打开页面并回应。' : '回应已保存。');
    } catch (error) {
      if (current(auth, generation)) status(error.name === 'AbortError' ? '尚未确认保存结果，可重试；同一次请求不会重复发送。' : error.message, true);
    } finally { if (generation === epoch) { busy = false; render(); } }
  }

  function open() {
    if (!token()) return;
    if (loadedToken && loadedToken !== token()) dispose();
    ensure(); if (!dialog.open) dialog.showModal(); notice.hidden = true;
    if (snapshot && loadedToken === token()) render(); else content.textContent = '正在读取家庭成员…';
    refresh(true);
  }

  function dispose() {
    epoch++; for (const controller of controllers) controller.abort(); controllers.clear();
    busy = false; checking = false; lastCheck = 0; snapshot = null; loadedToken = ''; retryRequest = null;
    if (dialog?.open) dialog.close(); if (content) content.replaceChildren(); if (notice) notice.hidden = true;
  }

  window.MemoryContact = { open, dispose, refresh };
  window.addEventListener('pagehide', dispose);
})();
