'use strict';
const crypto = require('node:crypto');

const TTL = 10 * 60000, LEASE = 2 * 60000, MAX_ACTIONS = 20, MAX_PREPARES = 40;
const ACTIONS = new Set(['aiActionPrepare', 'aiActionGet', 'aiActionConfirm', 'aiActionCancel']);
const EDITABLE = new Set(['draft', 'ready']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,190}$/.test(value);
const account = s => s.account || s.accountId || s._id;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const effectId = (item, index) => 'aic_' + item.actionId.slice(4) + '_v' + item.version + '_' + index;

// A model proposes content only. This module never runs from model output: the UI
// prepares a preview, then explicitly confirms its server-issued id and version.
function createActions(store, { authenticate, roster, send, contactRequest, callCapabilities, callRequest, clock = Date.now } = {}) {
  for (const dependency of [authenticate, roster, send, contactRequest]) {
    if (typeof dependency !== 'function') throw new TypeError('AI actions require authorization and execution adapters');
  }

  async function authorize(session, token) {
    const s = await authenticate(token);
    if (!s || !validId(s._id) || s._id !== session?._id || s.room !== session.room ||
      s.role !== session.role || account(s) !== account(session) || !['owner', 'family', 'frame'].includes(s.role)) {
      fail('登录已失效，请重新登录', 401);
    }
    return s;
  }
  const docId = s => 'aa_' + hash(s._id);
  function record(old, s) {
    if (old && (old.room !== s.room || old.session !== s._id || old.account !== account(s))) fail('候选行动不存在', 404);
    return old || { _id: docId(s), kind: 'ai-actions', room: s.room, session: s._id, account: account(s), entries: [], budget: { since: clock(), count: 0 } };
  }
  function find(record, id, version) {
    const item = record.entries.find(entry => entry.actionId === id);
    if (!item) fail('候选行动不存在，请重新准备', 404);
    if (version !== undefined && item.version !== version) fail('候选已修改，请查看最新内容再确认', 409);
    return item;
  }
  function state(item) {
    if (!['completed', 'cancelled'].includes(item.status) && item.expiresAt <= clock() &&
      !(item.status === 'processing' && item.leaseUntil > clock())) return 'expired';
    return item.status;
  }
  function preview(item) {
    return { actionId: item.actionId, version: item.version, kind: item.actionKind,
      targetId: item.targetId, targetName: item.targetName, text: item.text,
      messageIds: item.messageIds, photos: item.photos.map(({ messageId, imageId }) => ({ messageId, imageId })), audioId: item.audioId,
      visibility: item.actionKind === 'message' ? 'family' : 'participants',
      mode: item.actionKind === 'contact' ? item.mode : 'family-message',
      // This describes the explicitly selected method, never connection state.
      audioCall: item.actionKind === 'contact' && item.mode === 'audio-call',
      ...(item.actionKind === 'contact' && item.mode === 'audio-call' ? { callRequestId: effectId(item, 0) } : {}),
      expiresAt: item.expiresAt, status: state(item), needs: item.needs,
      started: Boolean(item.startedAt), completed: item.results.length, results: item.results, ...(item.error ? { error: item.error } : {}) };
  }
  function input(data, s) {
    if (!['message', 'contact'].includes(data.kind)) fail('请选择留言或联系家人');
    if (data.targetId !== undefined && data.targetId !== '' && !validId(data.targetId)) fail('请选择真实家庭成员');
    if (data.text !== undefined && (typeof data.text !== 'string' || data.text.length > 2700)) fail('留言请控制在 2700 字以内');
    const ids = data.messageIds ?? [];
    if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => !validId(id) || !id.startsWith('m_'))) fail('请选择至多 4 张不同的家庭照片');
    if (data.audioId !== undefined && data.audioId !== '' && (!validId(data.audioId) || data.audioId.length > 90)) fail('请选择当前家庭的原声录音');
    if (data.kind === 'contact' && data.mode !== undefined && data.mode !== '' && !['request-only', 'audio-call'].includes(data.mode)) fail('请选择音频通话或站内联系提醒');
    return { actionKind: data.kind, targetId: data.targetId || '', text: data.kind === 'message' ? (data.text || '').trim() : '',
      messageIds: data.kind === 'message' ? ids : [], audioId: data.kind === 'message' ? (data.audioId || '') : '',
      mode: data.kind === 'contact' ? (data.mode || '') : 'family-message' };
  }
  async function validate(value, s, original) {
    const currentRoster = await roster(s), members = Array.isArray(currentRoster) ? currentRoster : currentRoster.members;
    const target = value.targetId ? members?.find(member => member.id === value.targetId) : null;
    if (value.targetId && (!target || value.targetId === account(s) || value.targetId === s._id)) fail('这位成员已离开家庭或登录已失效，请重新选择', 404);
    const targetName = String(target?.name || '').slice(0, 30);
    if (original && targetName !== original.targetName) fail('成员称呼已改变，请重新准备确认内容', 409);
    // Persisted results are the only evidence that a step already succeeded.
    // Keep its original preview, but do not reread sources that will not be sent
    // again: a family may delete them while the remaining steps await a retry.
    const completed = original?.results?.length || 0, photos = [];
    for (const [index, id] of value.messageIds.entries()) {
      if (index < completed) { photos.push(original.photos[index]); continue; }
      const message = await store.get(id);
      if (!message || message.kind !== 'message' || message.room !== s.room || message.deleted || !message.image) fail('选中的照片已不存在，请重新选择', 404);
      const file = await store.get('f_' + message.image);
      if (!file || file.kind !== 'file' || file.room !== s.room || file.deleted || file.revoked ||
        !['image/jpeg', 'image/png'].includes(file.mime) || !file.file || !Number.isFinite(file.bytes) || file.bytes <= 0 || file.bytes > 3000000) fail('选中的照片文件已不可用', 404);
      photos.push({ messageId: id, imageId: message.image, file: file.file, digest: file.digest || '', bytes: file.bytes, mime: file.mime });
    }
    let audio = completed ? original.audio : null;
    // Original audio is attached to the first send only.
    if (value.audioId && !completed) {
      const file = await store.get('f_' + value.audioId);
      if (!file || file.kind !== 'file' || file.room !== s.room || file.deleted || file.revoked || file.mime !== 'audio/wav' ||
        !file.file || !Number.isFinite(file.bytes) || file.bytes <= 44 || file.bytes > 60 * 32000 + 44) fail('原声录音已不可用，请重新录音', 404);
      audio = { id: value.audioId, file: file.file, digest: file.digest || '', bytes: file.bytes, mime: file.mime };
    }
    if (original && (JSON.stringify(photos) !== JSON.stringify(original.photos) || JSON.stringify(audio) !== JSON.stringify(original.audio))) fail('照片或原声已改变，请重新准备确认内容', 409);
    const needs = [];
    if (!target) needs.push('target');
    if (value.actionKind === 'message' && !value.text && !photos.length && !audio) needs.push('content');
    if (value.actionKind === 'contact' && !['request-only', 'audio-call'].includes(value.mode)) needs.push('mode');
    if (value.actionKind === 'contact' && value.mode === 'audio-call') {
      if (typeof callCapabilities !== 'function' || typeof callRequest !== 'function') fail('家庭语音通话尚未配置，不能发起呼叫', 503);
      const available = await callCapabilities(s);
      if (available?.audioCall !== true) fail(typeof available?.reason === 'string' && available.reason.trim()
        ? available.reason.trim().slice(0, 200) : '家庭语音通话当前不可用，请稍后再试', 503);
    }
    return { targetName, photos, audio, needs };
  }
  async function read(s, id, version) { return find(record(await store.get(docId(s)), s), id, version); }
  async function change(s, id, version, transform) {
    const saved = await store.mutate(docId(s), old => {
      const current = record(old, s), item = find(current, id, version);
      const next = transform(item);
      current.entries = current.entries.map(entry => entry.actionId === id ? next : entry);
      return current;
    });
    return find(saved, id, version);
  }
  function runnable(item) {
    if (state(item) === 'expired') fail('确认已过期，请重新准备并确认', 410);
    if (item.status === 'cancelled') fail('这项候选已取消', 409);
    if (item.needs.length) fail('请补全收件人、内容和联系方式后再确认', 400);
  }

  async function handle(action, data, session, token) {
    if (!ACTIONS.has(action)) fail('未知候选行动操作', 404);
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('候选行动格式不正确');
    const keys = action === 'aiActionPrepare' ? ['actionId', 'version', 'kind', 'targetId', 'text', 'messageIds', 'audioId', 'mode']
      : action === 'aiActionGet' ? ['actionId'] : ['actionId', 'version'];
    if (Object.keys(data).some(key => !keys.includes(key))) fail('请使用当前确认卡操作，不要附带修改后的执行内容');
    const s = await authorize(session, token);
    if (data.actionId !== undefined && (!validId(data.actionId) || !data.actionId.startsWith('aia_'))) fail('候选行动不存在', 404);
    if (data.version !== undefined && (!Number.isSafeInteger(data.version) || data.version < 1)) fail('确认版本无效');
    if (action !== 'aiActionPrepare' && !data.actionId) fail('请使用当前确认卡操作');
    if ((data.actionId && action !== 'aiActionGet') && data.version === undefined) fail('请使用当前确认卡的版本');
    if (action === 'aiActionPrepare') {
      const value = input(data, s), checked = await validate(value, s);
      await authorize(s, token);
      const id = data.actionId || 'aia_' + crypto.randomUUID();
      const saved = await store.mutate(docId(s), old => {
        const current = record(old, s), time = clock();
        let previous;
        if (data.actionId) {
          previous = find(current, id, data.version);
          if (!EDITABLE.has(previous.status) || state(previous) === 'expired' || previous.startedAt) fail('这项候选已开始执行、取消或过期，请重新准备', 409);
        }
        const budget = current.budget.since > time - TTL ? current.budget : { since: time, count: 0 };
        if (budget.count >= MAX_PREPARES) fail('准备操作过于频繁，请稍后再试', 429);
        if (!previous && current.entries.length >= MAX_ACTIONS) {
          const removable = current.entries.findIndex(entry => ['completed', 'cancelled', 'expired'].includes(state(entry)));
          if (removable < 0) fail('待确认事项较多，请先取消不需要的候选', 429);
          current.entries.splice(removable, 1);
        }
        const item = { ...value, ...checked, actionId: id, version: previous ? previous.version + 1 : 1,
          status: checked.needs.length ? 'draft' : 'ready', createdAt: previous?.createdAt || time, expiresAt: time + TTL,
          results: [], lease: '', leaseUntil: 0, startedAt: 0, error: '' };
        current.entries = current.entries.filter(entry => entry.actionId !== id).concat(item);
        current.budget = { since: budget.since, count: budget.count + 1 };
        return current;
      });
      return preview(find(saved, id));
    }
    let item = await read(s, data.actionId, data.version);
    if (action === 'aiActionGet') return preview(item);
    if (action === 'aiActionCancel') {
      item = await change(s, data.actionId, data.version, current => {
        if (current.status === 'completed') fail('这项操作已完成，不能通过取消候选撤回', 409);
        if (current.status === 'processing') fail('操作执行结果尚未确认，请重试查询结果后再取消剩余内容', 409);
        return { ...current, status: 'cancelled', lease: '', leaseUntil: 0,
          error: !current.startedAt ? '' : current.actionKind === 'message'
            ? '已停止后续操作；已经发送的内容不会撤回，请查看家庭记忆或联系记录。'
            : current.mode === 'audio-call' ? '已取消后续重试；可能已经创建呼叫，请到家庭通话中查看并挂断。'
              : '已取消后续重试；可能已经发出联系提醒，请查看联系记录。' };
      });
      return preview(item);
    }
    runnable(item);
    const checked = await validate(item, s, item);
    if (checked.needs.length) fail('请补全候选内容后重新确认');
    // Even completed confirmation retries recheck the current target, media and
    // calling capability; they then return the original result without an effect.
    if (item.status === 'completed') return preview(item);
    await authorize(s, token);
    const lease = crypto.randomUUID();
    item = await change(s, data.actionId, data.version, current => {
      runnable(current);
      if (current.status === 'completed') return current;
      if (current.status === 'processing' && current.leaseUntil > clock()) fail('正在执行这项确认，请勿重复点击', 409);
      return { ...current, status: 'processing', lease, leaseUntil: clock() + LEASE, startedAt: current.startedAt || clock(), error: '' };
    });
    if (item.status === 'completed') return preview(item);
    const checkpoint = transform => change(s, item.actionId, item.version, current => {
      if (current.lease !== lease || current.status !== 'processing') fail('确认执行状态已改变，请刷新查看结果', 409);
      return transform(current);
    });
    try {
      const count = item.actionKind === 'message' ? Math.max(1, item.photos.length) : 1;
      for (let i = item.results.length; i < count; i++) {
        await authorize(s, token);
        await validate(item, s, item);
        // Extend and check the durable lease immediately before every effect. A
        // crash or an ambiguous response is retried with exactly the same id.
        item = await checkpoint(current => { runnable(current); return { ...current, leaseUntil: clock() + LEASE }; });
        const stableId = effectId(item, i);
        let result;
        if (item.actionKind === 'message') {
          const sent = await send({ id: stableId, image: item.photos[i]?.imageId || '', audio: i === 0 ? item.audioId : '',
            text: '给' + item.targetName + '的留言（家庭共享）' + (i === 0 && item.text ? '\n' + item.text : ''),
            title: '给' + item.targetName + '的留言（家庭共享）' }, token);
          result = { kind: 'message', id: sent.id };
        } else if (item.mode === 'audio-call') {
          const started = await callRequest({ targetId: item.targetId, requestId: stableId }, s);
          if (!validId(started?.callId)) fail('语音通话创建结果尚未确认，请重试当前确认检查同一次呼叫', 503);
          result = { kind: 'contact', mode: 'audio-call', callId: started.callId, requestId: stableId };
        } else {
          await contactRequest({ targetId: item.targetId, requestId: stableId }, s);
          result = { kind: 'contact', mode: 'request-only', requestId: stableId };
        }
        item = await checkpoint(current => ({ ...current, results: current.results.concat(result), leaseUntil: clock() + LEASE }));
      }
      item = await checkpoint(current => ({ ...current, status: 'completed', lease: '', leaseUntil: 0, completedAt: clock() }));
      await authorize(s, token);
      return preview(item);
    } catch (error) {
      await change(s, item.actionId, item.version, current => current.lease === lease && current.status === 'processing'
        ? { ...current, status: 'failed', lease: '', leaseUntil: 0,
          error: current.actionKind === 'contact' ? (current.mode === 'audio-call'
            ? '呼叫请求结果尚未确认；重试会检查同一次呼叫，不会自动改发联系提醒。'
            : '联系提醒结果尚未确认；可重试相同候选，系统会防止重复发送。')
            : current.results.length ? '部分内容已发送；重试会继续剩余内容，不重复发送。' : '执行未确认完成；可重试相同候选，系统会防止重复发送。' }
        : current).catch(() => {});
      throw error;
    }
  }
  return { handle };
}

module.exports = { createActions, TTL, LEASE, MAX_ACTIONS, MAX_PREPARES };
