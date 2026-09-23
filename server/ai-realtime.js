'use strict';
const crypto = require('node:crypto');
const { createTRTC } = require('./ai-realtime-trtc');
const MAX_MS = 10 * 60000, HEARTBEAT_MS = 10000, LEASE_MS = 45000, RETENTION_MS = 86400000;
const START_TIMEOUT_MS = 20000, RECONCILE_MS = 60000;
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function createRealtime(store, { authenticate, provider = createTRTC(), clock = Date.now } = {}) {
  const recordId = s => 'air_' + s.room;
  const key = (s, id) => digest(s._id + ':' + id);
  const present = entry => ({ requestId: entry.requestId, status: entry.status, expiresAt: entry.expiresAt,
    heartbeatMs: HEARTBEAT_MS, maxSessionMs: MAX_MS, ...(entry.status === 'stopping' ? { reason: '本机音频已关闭，服务端正在确认停止' } : {}) });
  async function change(s, requestId, fn) {
    const target = key(s, requestId);
    const result = await store.mutate(recordId(s), old => {
      const record = old || { _id: recordId(s), kind: 'ai-realtime', room: s.room, entries: [] };
      record.entries = record.entries.filter(e => e.createdAt > clock() - RETENTION_MS || e.status !== 'ended');
      const index = record.entries.findIndex(e => e.key === target), entry = fn(index < 0 ? null : record.entries[index], record);
      if (!entry) return null;
      if (index < 0) {
        if (record.entries.length >= 60 || record.entries.filter(e => e.owner === s._id).length >= 20) fail('今天的实时对话操作已达演示上限', 429);
        record.entries.push(entry);
      } else record.entries[index] = entry;
      return record;
    });
    return result?.entries.find(e => e.key === target);
  }
  function initial(s, requestId, status) {
    const opaque = crypto.randomBytes(12).toString('hex');
    return { key: key(s, requestId), requestId, owner: s._id, createdAt: clock(), expiresAt: clock() + MAX_MS,
      leaseUntil: clock() + LEASE_MS, status, rtcRoom: 'unseen_' + opaque, userId: 'u_' + opaque, agentId: 'a_' + opaque,
      providerSession: 'unseen_' + digest(s._id + ':' + requestId), taskId: '', attempted: false };
  }
  async function stop(s, requestId, expiredOnly = false) {
    let entry = await change(s, requestId, old => {
      // A room-wide scan is only a hint. A heartbeat may renew this exact entry
      // after the scan; re-evaluate expiry inside the same CAS that claims stop.
      if (old && expiredOnly && old.status !== 'stopping' && old.expiresAt > clock() && old.leaseUntil > clock()) return old;
      return old ? { ...old, status: old.status === 'ended' ? 'ended' : 'stopping', lastCleanupAttemptAt: clock() } : initial(s, requestId, 'ended');
    });
    if (entry.status !== 'stopping') return present(entry);
    try {
      const taskId = entry.taskId || (entry.attempted ? await provider.lookup(entry) : null);
      if (taskId) {
        // Persist discovery before Stop: a failed Stop must remain retryable even
        // if subsequent Describe calls are unavailable.
        entry = await change(s, requestId, old => ({ ...old, taskId }));
        await provider.stop(taskId);
      }
      // A start still in flight can create a task after lookup says absent.
      // Never erase the tombstone or claim completion until its owner settles.
      // Null must mean explicit TaskNotExist, not an empty response. If the
      // start worker crashed without settling, absence at this instant is not
      // enough: retain stopping so future sweeps can find and stop a late task.
      // A later successful Start always reopens cleanup below.
      const deadline = entry.uncertainUntil || entry.createdAt + START_TIMEOUT_MS + RECONCILE_MS;
      const settled = Boolean(taskId) || !entry.attempted || (entry.startSettled && deadline <= clock());
      entry = await change(s, requestId, old => {
        if (old.status === 'ended') return old;
        // An older lookup cannot settle a task discovered while it was pending.
        if (old.taskId && old.taskId !== taskId) return old;
        return { ...old, status: settled ? 'ended' : 'stopping' };
      });
    } catch { /* Durable stopping remains retryable; provider errors may contain keys. */ }
    return present(entry);
  }
  async function cleanup(s) {
    const record = await store.get(recordId(s));
    for (const entry of record?.entries || []) {
      if (entry.status === 'ended') continue;
      if (entry.status === 'stopping' || entry.expiresAt <= clock() || entry.leaseUntil <= clock()) await stop({ _id: entry.owner, room: s.room }, entry.requestId, true);
    }
  }
  async function handle(action, data, s, token, signal) {
    const caps = provider.capabilities();
    if (action === 'aiRealtimeCapabilities') return { ...caps, maxSessionMs: MAX_MS, heartbeatMs: HEARTBEAT_MS, requiresSecureContext: true, mode: 'duplex-audio' };
    if (!validId(data.requestId)) fail('实时对话标识无效');
    if (action === 'aiRealtimeStop') return stop(s, data.requestId);
    if (!caps.enabled) fail(caps.reason, 503);
    await cleanup(s);
    if (action === 'aiRealtimeStatus') {
      const entry = await change(s, data.requestId, old => {
        if (!old) fail('实时对话不存在', 404);
        return old.status === 'active' && old.expiresAt > clock() ? { ...old, leaseUntil: clock() + LEASE_MS } : old;
      });
      return present(entry);
    }
    if (action !== 'aiRealtimeStart') fail('未知实时语音操作', 404);
    signal?.throwIfAborted();
    // One atomic reservation per request, including cancellation before start.
    const attempt = crypto.randomUUID();
    let entry = await change(s, data.requestId, (old, record) => {
      if (old) return old;
      if (record.entries.filter(e => e.owner === s._id).length >= 20) fail('今天的实时对话次数已达演示上限', 429);
      if (record.entries.some(e => e.owner === s._id && e.status !== 'ended')) fail('上一段实时对话尚未结束，请稍后重试', 409);
      if (record.entries.filter(e => e.status !== 'ended').length >= 2) fail('家里已有两段实时对话，请稍后重试', 429);
      return { ...initial(s, data.requestId, 'starting'), attempt };
    });
    if (entry.attempt !== attempt) {
      // Credential replay is deliberately forbidden; a new user gesture/request
      // is needed after cancellation or an uncertain response.
      return present(entry);
    }
    const cancelled = () => { void stop(s, data.requestId).catch(() => {}); };
    signal?.addEventListener('abort', cancelled, { once: true });
    let createdTaskId;
    try {
      await authenticate(token); signal?.throwIfAborted();
      entry = await change(s, data.requestId, old => old.status === 'starting' ? {
        ...old, attempted: true, uncertainUntil: clock() + START_TIMEOUT_MS + RECONCILE_MS
      } : old);
      if (entry.status !== 'starting') return present(entry);
      const taskId = createdTaskId = await provider.start(entry);
      entry = await change(s, data.requestId, old => ({ ...old, taskId, startSettled: true,
        status: old.status === 'starting' ? 'starting' : 'stopping' }));
      await authenticate(token);
      if (signal?.aborted || entry.status !== 'starting' || entry.leaseUntil <= clock() || entry.expiresAt <= clock()) return await stop(s, data.requestId);
      entry = await change(s, data.requestId, old => old.status === 'starting' && old.leaseUntil > clock() && old.expiresAt > clock()
        ? { ...old, status: 'active', leaseUntil: clock() + LEASE_MS } : old);
      if (entry.status !== 'active') return await stop(s, data.requestId);
      return { ...present(entry), provider: caps.provider, connection: provider.credentials(entry) };
    } catch (error) {
      // Even a timed-out start may have been accepted. Resolve by SessionId and
      // stop it; do not blindly create/retry a second paid provider task.
      // Database failures must not skip stopping a TaskId already in memory.
      // The durable pre-start reservation also lets the next sweep reconcile it.
      if (createdTaskId) { try { await provider.stop(createdTaskId); } catch {} }
      try {
        await change(s, data.requestId, old => ({ ...old, ...(createdTaskId ? { taskId: createdTaskId } : {}),
          startSettled: true, uncertainUntil: old.taskId || createdTaskId ? 0 : clock() + RECONCILE_MS }));
        await stop(s, data.requestId);
      } catch { /* Keep durable reservation; never expose database/provider errors. */ }
      if (error.status === 401) throw error;
      fail('实时语音连接未完成，请重试；若持续失败，请检查服务开通、模型和音色配置', 503);
    } finally { signal?.removeEventListener('abort', cancelled); }
  }
  async function endForSession(s) {
    const record = await store.get(recordId(s));
    await Promise.all((record?.entries || []).filter(e => e.owner === s._id && e.status !== 'ended').map(e => stop(s, e.requestId)));
  }
  // Trusted maintenance only; never exposed as a family /api action. The cloud
  // Timer/runner supplies its own execution boundary, independent of traffic.
  async function cleanupExpired({ maxEntries = 20, budgetMs = 25000, stopAll = false } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100 || !Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 60000 || typeof stopAll !== 'boolean') fail('清理参数无效');
    const startedAt = Date.now();
    const records = await store.list('ai-realtime');
    const pending = records.flatMap(record => (record.entries || []).filter(e => e.status !== 'ended' &&
      (stopAll || e.status === 'stopping' || e.expiresAt <= clock() || e.leaseUntil <= clock()))
      .map(entry => ({ entry, room: record.room })));
    // Repeated provider failures must not starve other families on bounded runs.
    pending.sort((a, b) => (a.entry.lastCleanupAttemptAt || 0) - (b.entry.lastCleanupAttemptAt || 0));
    const result = { scanned: records.length, candidates: pending.length, attempted: 0, ended: 0, pending: 0, skipped: 0, errors: 0, deferred: 0 };
    for (const { entry, room } of pending) {
      if (result.attempted >= maxEntries || Date.now() - startedAt >= budgetMs) break;
      result.attempted++;
      try {
        const status = (await stop({ _id: entry.owner, room }, entry.requestId, !stopAll)).status;
        result[status === 'ended' ? 'ended' : status === 'stopping' ? 'pending' : 'skipped']++;
      } catch { result.errors++; }
    }
    result.deferred = pending.length - result.attempted;
    return result;
  }
  return { handle, endForSession, cleanupExpired, enabled: () => provider.capabilities().enabled };
}
module.exports = { createRealtime, MAX_MS, HEARTBEAT_MS, LEASE_MS, START_TIMEOUT_MS, RECONCILE_MS };
