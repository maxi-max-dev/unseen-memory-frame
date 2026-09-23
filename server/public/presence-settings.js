'use strict';
globalThis.MemoryPresenceSettings = (() => {
  let dialog, identity = '', generation = 0, controller, secretTimer;
  const el = id => dialog?.querySelector('#' + id);
  const authorized = () => !frame && session?.role === 'owner' && !sessionExpired && !authScreenActive;
  const active = epoch => dialog?.open && epoch === generation && authorized() && identity === session?.token;
  function clearSecret() { clearTimeout(secretTimer); el('sensorSecret')?.replaceChildren(); }
  function close() { generation++; controller?.abort(); controller = null; clearSecret(); dialog?.close(); dialog?.remove(); dialog = null; identity = ''; }
  async function request(action, data = {}) {
    controller?.abort(); const pending = new AbortController(); controller = pending;
    const timeout = setTimeout(() => pending.abort(), 12000);
    try { return await api(action, data, identity, { signal: pending.signal }); } finally { clearTimeout(timeout); }
  }
  function revealSecret(token) {
    clearSecret(); if (typeof token !== 'string' || !token) return;
    const box = el('sensorSecret'); box.innerHTML = '<div class="sensor-secret"><strong>本次令牌仅显示一次</strong><p>只通过私密渠道交给 Windows 设备管理员。关闭页面、切到后台或一分钟后清除；需要时可轮换新令牌。</p><label>PRESENCE_SENSOR_TOKEN<input id="presenceSensorToken" type="password" readonly autocomplete="off" spellcheck="false"></label><div class="row"><button id="sensorReveal" type="button">显示令牌</button><button id="sensorCopy" type="button">复制令牌</button><button id="sensorClear" type="button">清除显示</button></div></div>';
    el('presenceSensorToken').value = token;
    el('sensorReveal').onclick = () => { const field = el('presenceSensorToken'); field.type = field.type === 'password' ? 'text' : 'password'; el('sensorReveal').textContent = field.type === 'password' ? '显示令牌' : '隐藏令牌'; };
    el('sensorCopy').onclick = async () => { try { await navigator.clipboard.writeText(el('presenceSensorToken').value); if (el('sensorStatus')) el('sensorStatus').textContent = '令牌已复制，请仅通过私密渠道传递。'; } catch { if (el('sensorStatus')) el('sensorStatus').textContent = '浏览器不允许复制，请显示后手动复制。'; } };
    el('sensorClear').onclick = clearSecret;
    secretTimer = setTimeout(clearSecret, 60000);
  }
  function render(data) {
    const frames = Array.isArray(data.frames) ? data.frames : [], sensors = Array.isArray(data.sensors) ? data.sensors : [];
    const options = frames.map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.id.slice(-8))} · ${item.online ? '在线' : '离线'}</option>`).join('');
    el('sensorFrame').innerHTML = options || '<option value="">请先配对一台相框</option>';
    el('sensorIssue').disabled = !frames.length;
    el('sensorList').innerHTML = sensors.length ? sensors.map(sensor => {
      const target = frames.find(item => item.id === sensor.targetFrameId);
      return `<section class="sensor-row"><strong>${esc(sensor.deviceId)}</strong><p>目标相框：${esc(target?.name || '已不可用的相框')} · ${esc(sensor.targetFrameId.slice(-8))} · ${sensor.active ? '已启用' : '已停用'}${sensor.targetAvailable === false ? ' · 需要重新绑定' : ''}</p><div class="row">${sensor.active && sensor.targetAvailable !== false ? `<button type="button" data-sensor-rotate="${esc(sensor.deviceId)}">轮换令牌</button>` : ''}${sensor.active ? `<button type="button" data-sensor-revoke="${esc(sensor.deviceId)}">停用传感器</button>` : ''}</div></section>`;
    }).join('') : '<p class="muted">还没有绑定的传感器。</p>';
    dialog.querySelectorAll('[data-sensor-rotate]').forEach(button => { button.onclick = () => { if (confirm('轮换后旧令牌立即失效，需要更新 Windows 上报器。继续轮换？')) void mutate('presenceSensorRotate', { deviceId: button.dataset.sensorRotate }); }; });
    dialog.querySelectorAll('[data-sensor-revoke]').forEach(button => { button.onclick = () => { if (confirm('停用后，这台传感器将不能再发出聊天邀请。继续停用？')) void mutate('presenceSensorRevoke', { deviceId: button.dataset.sensorRevoke }); }; });
  }
  async function refresh(epoch) { const data = await request('presenceSensorList'); if (active(epoch)) render(data); }
  async function mutate(action, data) {
    if (!authorized() || !dialog?.open || dialog.dataset.busy === 'true') return;
    const epoch = generation; dialog.dataset.busy = 'true'; clearSecret();
    dialog.querySelectorAll('button:not(#sensorClose), input, select').forEach(control => { control.disabled = true; });
    el('sensorStatus').textContent = '正在保存…';
    try {
      const result = await request(action, data); if (!active(epoch)) return;
      el('sensorStatus').textContent = action === 'presenceSensorRevoke' ? '传感器已停用。' : '已绑定到所选家庭相框。请保存本次令牌。';
      // Keep a newly issued token available even if the following list refresh fails.
      revealSecret(result.token);
      try { await refresh(epoch); } catch { if (active(epoch)) el('sensorStatus').textContent += ' 设备列表暂未刷新，请关闭后重试。'; }
    } catch (error) { if (active(epoch)) el('sensorStatus').textContent = error.name === 'AbortError' ? '等待超时，结果尚未确认。关闭后重新查看；令牌未收到可再次轮换。' : error.message; }
    finally { if (active(epoch)) { dialog.dataset.busy = 'false'; dialog.querySelectorAll('button, input, select').forEach(control => { control.disabled = false; }); el('sensorIssue').disabled = !el('sensorFrame').value; } }
  }
  async function open() {
    if (!authorized()) return;
    close(); identity = session.token; const epoch = generation;
    $('#modal').close(); dialog = document.createElement('dialog'); dialog.id = 'presenceSettings'; dialog.className = 'presence-settings'; dialog.setAttribute('aria-labelledby', 'sensorTitle');
    dialog.innerHTML = '<div class="row between"><h2 id="sensorTitle">相框驻足邀请</h2><button id="sensorClose" type="button">关闭 ×</button></div><p>Link 2 只上报有人停留的事件，不上传摄像头画面，也不判断身份或注视。老人确认邀请后才打开 AI 聊天。</p><div id="sensorList"></div><h3>绑定传感器</h3><form id="sensorForm"><label>设备标识<input id="sensorDevice" name="deviceId" value="living-room-link2" required maxlength="64" pattern="[A-Za-z0-9._\\-]{1,64}" autocomplete="off"></label><label>目标相框<select id="sensorFrame" name="targetFrameId" required><option value="">正在读取…</option></select></label><p class="muted">仅绑定当前家庭的一台相框。相框退出或被移除后，请重新绑定。</p><button id="sensorIssue" class="primary" type="submit" disabled>签发传感器令牌</button></form><p id="sensorStatus" role="status">正在读取设备…</p><div id="sensorSecret"></div>';
    document.body.append(dialog); dialog.showModal();
    el('sensorClose').onclick = close; dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    el('sensorForm').onsubmit = event => { event.preventDefault(); void mutate('presenceSensorIssue', { deviceId: el('sensorDevice').value.trim(), targetFrameId: el('sensorFrame').value }); };
    try { await refresh(epoch); if (active(epoch)) el('sensorStatus').textContent = '事件有效期 15 秒；忙碌或后台时忽略，不延后打扰。'; }
    catch (error) { if (active(epoch)) el('sensorStatus').textContent = error.name === 'AbortError' ? '读取超时，请关闭后重试。' : error.message; }
  }
  function mount() {
    if (!authorized() || $('#presenceSettingsEntry')) return;
    const button = document.createElement('button'); button.id = 'presenceSettingsEntry'; button.type = 'button'; button.textContent = '管理相框驻足邀请'; button.onclick = open;
    $('#logout').before(button);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  globalThis.addEventListener('pagehide', close);
  return { mount, close };
})();
