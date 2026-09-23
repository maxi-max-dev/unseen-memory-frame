'use strict';
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const EVENT_TTL_MS = 15000, DEDUP_MS = 60000, FUTURE_SKEW_MS = 30000;
const MAX_SENSORS = 8, MAX_EVENTS = 128, MAX_BODY_BYTES = 2048;
const DEVICE = /^[a-zA-Z0-9._-]{1,64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^ps1\.([a-f0-9-]{36})\.([a-f0-9]{64})$/;
const ACTIONS = ['presenceSensorList', 'presenceSensorIssue', 'presenceSensorRotate', 'presenceSensorRevoke'];
function fields(data, keys) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) fail('传感器请求字段不正确');
}
function validate(data) {
  fields(data, ['version', 'eventId', 'source', 'deviceId', 'type', 'occurredAt', 'dwellMs', 'headCount']);
  if (data.version !== 1 || data.source !== 'link2-windows' || data.type !== 'presence.dwell' ||
      typeof data.eventId !== 'string' || !UUID.test(data.eventId) || typeof data.deviceId !== 'string' || !DEVICE.test(data.deviceId) ||
      !Number.isSafeInteger(data.occurredAt) || data.occurredAt <= 0 || !Number.isSafeInteger(data.dwellMs) || data.dwellMs < 0 || data.dwellMs > 86400000 ||
      !Number.isSafeInteger(data.headCount) || data.headCount < 0 || data.headCount > 10) fail('驻足事件格式不正确');
  // Only a digest is retained for matching retries; raw camera measurements are discarded.
  return { ...data, eventId: data.eventId.toLowerCase() };
}
const sameDigest = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === 64 && right.length === 64 &&
  crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));

function createPresence(store, { clock = Date.now, allowed = async () => true, timers = true, log = entry => console.info('[presence]', JSON.stringify(entry)) } = {}) {
  const scheduled = new Map();
  let nextSweep = 0;
  const docId = room => 'presence_' + room;
  const initial = room => ({ _id: docId(room), kind: 'presence', room, seq: 0, sensors: [], events: [] });
  const activeSession = (session, room, time) => session?.kind === 'session' && session.room === room && !session.revoked && session.expires > time;
  async function target(id, room, status = 400) {
    const session = typeof id === 'string' && /^s_[a-f0-9]{64}$/.test(id) ? await store.get(id) : null;
    if (!activeSession(session, room, clock()) || session.role !== 'frame' || !await allowed(session)) fail('目标相框已失效，请重新配对并绑定', status);
    return session;
  }
  async function owner(s) {
    const current = await store.get(s._id);
    if (!activeSession(current, s.room, clock()) || !await allowed(current)) fail('登录已过期', 401);
    if (current.role !== 'owner') fail('仅家庭创建者可管理传感器', 403);
  }
  function prune(doc, time) {
    const events = (doc.events || []).filter(event => event.dedupUntil > time).map(event => event.expiresAt > time ? event : receipt(event));
    // Arrays are replaced as a whole by CloudBase.update; an empty object would
    // be flattened into no updates and accidentally retain old digest keys.
    const budgets = (doc.budgets || []).filter(budget => budget.until > time);
    return { ...doc, events, budgets };
  }
  function receipt(event) { return { key: event.key, fingerprint: event.fingerprint, sensorDigest: event.sensorDigest, seq: event.seq, dedupUntil: event.dedupUntil }; }
  function needsCleanup(doc, time) {
    return (doc?.events || []).some(event => event.dedupUntil <= time || (event.expiresAt !== undefined && event.expiresAt <= time)) ||
      (doc?.budgets || []).some(budget => budget.until <= time);
  }
  function schedule(doc) {
    if (!timers || !doc) return;
    const due = Math.min(...(doc.events || []).flatMap(event => [event.expiresAt, event.dedupUntil].filter(Number.isFinite)),
      ...(doc.budgets || []).map(budget => budget.until));
    const old = scheduled.get(doc.room);
    if (old?.due === due) return;
    if (old) clearTimeout(old.timer);
    scheduled.delete(doc.room);
    if (!Number.isFinite(due)) return;
    const timer = setTimeout(async () => {
      scheduled.delete(doc.room);
      try { await cleanupRoom(doc.room); } catch { /* Startup and subsequent traffic retry cleanup after suspension/failure. */ }
    }, Math.max(1, due - clock()));
    timer.unref?.(); scheduled.set(doc.room, { timer, due });
  }
  async function cleanupRoom(room) {
    let doc = await store.get(docId(room));
    if (needsCleanup(doc, clock())) doc = await store.mutate(docId(room), current => current ? prune(current, clock()) : null);
    schedule(doc); return doc;
  }
  async function cleanupExpired(force = false) {
    if (!force && nextSweep > clock()) return;
    nextSweep = clock() + 60000;
    // Keep the one-minute retry backoff during a storage outage.
    for (const doc of await store.list('presence')) {
      if (needsCleanup(doc, clock())) await cleanupRoom(doc.room); else schedule(doc);
    }
  }
  function sensorFor(doc, digest, deviceId, time) {
    const sensor = doc?.sensors.find(item => sameDigest(item.digest, digest));
    if (!sensor || sensor.revokedAt || sensor.expiresAt <= time || sensor.deviceId !== deviceId) fail('传感器令牌无效或已撤销', 401);
    return sensor;
  }
  function publicSensor(sensor, available) {
    return { deviceId: sensor.deviceId, targetFrameId: sensor.targetFrameId, createdAt: sensor.createdAt,
      rotatedAt: sensor.rotatedAt || null, revokedAt: sensor.revokedAt || null, expiresAt: sensor.expiresAt,
      active: !sensor.revokedAt && sensor.expiresAt > clock(), targetAvailable: available };
  }
  async function manage(action, data, s) {
    await owner(s);
    fields(data, action === 'presenceSensorList' ? [] : action === 'presenceSensorIssue' ? ['deviceId', 'targetFrameId'] : ['deviceId']);
    if (action === 'presenceSensorList') {
      const doc = await cleanupRoom(s.room), frames = [];
      for (const frame of await store.list('session', s.room)) {
        if (activeSession(frame, s.room, clock()) && frame.role === 'frame' && await allowed(frame)) frames.push({ id: frame._id, name: frame.name,
          online: clock() - frame.lastSeen < 45000, expiresAt: frame.expires });
      }
      await owner(s);
      return { sensors: (doc?.sensors || []).map(sensor => publicSensor(sensor, frames.some(frame => frame.id === sensor.targetFrameId))), frames, eventTtlMs: EVENT_TTL_MS };
    }
    if (typeof data.deviceId !== 'string' || !DEVICE.test(data.deviceId)) fail('设备标识需为 1–64 位字母、数字、点、下划线或短横线');
    const before = await store.get(docId(s.room)), previous = before?.sensors.find(item => item.deviceId === data.deviceId);
    if (action !== 'presenceSensorIssue' && !previous) fail('传感器不存在', 404);
    const frame = action === 'presenceSensorRevoke' ? null : await target(action === 'presenceSensorIssue' ? data.targetFrameId : previous.targetFrameId, s.room);
    const token = action === 'presenceSensorRevoke' ? null : 'ps1.' + s.room + '.' + crypto.randomBytes(32).toString('hex');
    await owner(s);
    const doc = await store.mutate(docId(s.room), old => {
      const current = prune(old || initial(s.room), clock()), index = current.sensors.findIndex(item => item.deviceId === data.deviceId), existing = current.sensors[index];
      if (action === 'presenceSensorIssue' && existing && !existing.revokedAt && existing.expiresAt > clock()) fail('设备已绑定，请先轮换或撤销', 409);
      if (action !== 'presenceSensorIssue' && !existing) fail('传感器不存在', 404);
      if (action === 'presenceSensorRotate' && (existing.revokedAt || !sameDigest(existing.digest, previous.digest))) fail('传感器已变更，请刷新后重试', 409);
      if (index < 0 && current.sensors.length >= MAX_SENSORS) fail('每个家庭最多配置 8 个传感器标识', 409);
      const sensor = action === 'presenceSensorRevoke' ? { ...existing, digest: null, revokedAt: existing.revokedAt || clock() } :
        { deviceId: data.deviceId, targetFrameId: frame._id, digest: hash(token), expiresAt: frame.expires,
          createdAt: existing?.createdAt || clock(), rotatedAt: action === 'presenceSensorRotate' ? clock() : null, revokedAt: null };
      if (index < 0) current.sensors.push(sensor); else current.sensors[index] = sensor;
      // Invalidate delivery immediately while preserving short retry tombstones across rotation.
      current.events = current.events.map(event => sameDigest(event.sensorDigest, existing?.digest) ? receipt(event) : event);
      current.budgets = current.budgets.filter(budget => budget.key !== existing?.digest);
      return current;
    });
    schedule(doc);
    if (!token) return { ok: true };
    await target(frame._id, s.room);
    return { sensor: publicSensor(doc.sensors.find(item => item.deviceId === data.deviceId), true), token, eventTtlMs: EVENT_TTL_MS };
  }
  async function report(data, token) {
    const match = typeof token === 'string' && TOKEN.exec(token);
    if (!match || !UUID.test(match[1])) fail('需要独立传感器令牌', 401);
    const event = validate(data), room = match[1], digest = hash(token), time = clock();
    const eventKey = hash(event.eventId);
    const fingerprint = hash(JSON.stringify([event.version, event.source, event.deviceId, event.type, event.occurredAt, event.dwellMs, event.headCount]));
    const before = await store.get(docId(room)), sensor = sensorFor(before, digest, event.deviceId, time);
    await target(sensor.targetFrameId, room, 401);
    let duplicate = false;
    const doc = await store.mutate(docId(room), old => {
      const currentSensor = sensorFor(old, digest, event.deviceId, clock()), current = prune(old, clock());
      for (const [key, limit] of [['family', 240], [digest, 120]]) {
        let budget = current.budgets.find(item => item.key === key);
        if (!budget) { budget = { key, until: clock() + 60000, count: 0, unique: 0 }; current.budgets.push(budget); }
        if (budget.count >= limit) fail('传感器上报过于频繁，请稍后重试', 429);
        budget.count++;
      }
      const existing = current.events.find(item => item.key === eventKey);
      duplicate = Boolean(existing);
      if (existing) {
        if (existing.fingerprint !== fingerprint || !sameDigest(existing.sensorDigest, digest)) fail('同一事件标识不能对应不同内容或设备', 409);
        return current;
      }
      if (event.occurredAt <= clock() - DEDUP_MS || event.occurredAt > clock() + FUTURE_SKEW_MS) fail('事件时间过旧或设备时钟偏差过大');
      const familyBudget = current.budgets.find(item => item.key === 'family'), sensorBudget = current.budgets.find(item => item.key === digest);
      if (current.events.length >= MAX_EVENTS || familyBudget.unique >= 60 || sensorBudget.unique >= 30) fail('驻足事件过于频繁，请稍后重试', 429);
      familyBudget.unique++; sensorBudget.unique++;
      if (!Number.isSafeInteger(current.seq) || current.seq >= Number.MAX_SAFE_INTEGER) fail('事件序号不可用', 503);
      current.seq++;
      const receivedAt = clock();
      current.events.push({ key: eventKey, fingerprint, sensorDigest: digest, targetFrameId: currentSensor.targetFrameId,
        eventId: event.eventId, seq: current.seq, receivedAt, expiresAt: receivedAt + EVENT_TTL_MS,
        dedupUntil: Math.max(receivedAt, event.occurredAt) + DEDUP_MS });
      return current;
    });
    schedule(doc);
    // Rotation/revocation can race the write; recheck the committed generation and target before acknowledging.
    const latest = sensorFor(await store.get(docId(room)), digest, event.deviceId, clock());
    await target(latest.targetFrameId, room, 401);
    const accepted = doc.events.find(item => item.key === eventKey);
    log({ status: duplicate ? 'duplicate' : 'accepted', eventId: event.eventId, seq: accepted.seq });
    return { accepted: true, eventId: event.eventId, seq: accepted.seq };
  }
  async function snapshot(s) {
    if (s.role !== 'frame') return {};
    const doc = await cleanupRoom(s.room);
    if (!doc) return {};
    await target(s._id, s.room, 401);
    // Read again after asynchronous permission checks so revoked generations cannot be advertised.
    const latest = await store.get(docId(s.room));
    const event = (latest?.events || []).filter(item => item.targetFrameId === s._id && item.expiresAt > clock() &&
      latest.sensors.some(sensor => sensor.targetFrameId === s._id && !sensor.revokedAt && sensor.expiresAt > clock() && sameDigest(sensor.digest, item.sensorDigest)))
      .sort((a, b) => b.seq - a.seq)[0];
    if (!event) return {};
    return { presenceEvent: { seq: event.seq, eventId: event.eventId, type: 'presence.dwell', receivedAt: event.receivedAt, expiresAt: event.expiresAt } };
  }
  function close() { for (const item of scheduled.values()) clearTimeout(item.timer); scheduled.clear(); }
  return { manage, report, snapshot, cleanupExpired, close };
}
module.exports = { createPresence, ACTIONS, MAX_BODY_BYTES, EVENT_TTL_MS, DEDUP_MS, MAX_EVENTS };
