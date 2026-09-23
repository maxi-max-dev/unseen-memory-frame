'use strict';
const ACTIVITIES = new Set(['viewing', 'listening', 'recording', 'spatial', 'idle']);
const PRESENCE_TTL = 45000, HEARTBEAT_MIN_INTERVAL = 10000;
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };

function familyStats(messages, spatialState) {
  const visible = messages.filter(message => !message.deleted);
  return {
    photos: visible.filter(message => message.type === 'photo' && message.image).length,
    voices: visible.filter(message => message.audio).length,
    spatial: visible.filter(message => message.type === 'photo' && spatialState(message)?.status === 'ready').length,
    replies: visible.filter(message => message.type === 'reply').length,
    memories: visible.length
  };
}

function presentFrame(members, messages, spatialState, time) {
  const visible = new Map(messages.filter(message => !message.deleted && message.type === 'photo').map(message => [message._id, message]));
  const frames = members.filter(member => member.role === 'frame' && !member.revoked && member.expires > time).map(member => {
    const p = member.presence;
    const reported = p && ACTIVITIES.has(p.activity) && Number.isSafeInteger(p.updatedAt) && p.updatedAt > 0 && p.updatedAt <= time;
    const expiresAt = reported ? Math.min(p.updatedAt + PRESENCE_TTL, member.expires) : null;
    const online = Boolean(reported && expiresAt > time);
    const message = online && p.activity !== 'idle' ? visible.get(p.messageId) : null;
    const validContent = message && (p.activity !== 'listening' || message.audio) && (p.activity !== 'spatial' || spatialState(message)?.status === 'ready');
    // An explicit recent report means the device was connected; a removed or
    // unavailable memory must never remain advertised as being watched/heard.
    const activity = online ? (p.activity === 'idle' || !validContent ? 'idle' : p.activity) : null;
    return { online, activity, messageId: activity && activity !== 'idle' ? message._id : null,
      frameId: member._id, frameName: member.name, updatedAt: reported ? p.updatedAt : null, expiresAt,
      current: activity && activity !== 'idle' ? message : null };
  });
  // Prefer an actively reporting frame, then a recent explicit idle report.
  // Passive state polling (session.lastSeen) is never evidence of an activity.
  frames.sort((a, b) => Number(b.online && b.activity !== 'idle') - Number(a.online && a.activity !== 'idle') || Number(b.online) - Number(a.online) || (b.updatedAt || 0) - (a.updatedAt || 0) || a.frameId.localeCompare(b.frameId));
  return frames[0] || { online: false, activity: null, messageId: null, frameId: null, frameName: '', updatedAt: null, expiresAt: null, current: null };
}

function createFamilyState(store, spatial, options = {}) {
  const clock = options.clock || Date.now;
  function checkSession(current, session) {
    if (!current || current.kind !== 'session' || current.room !== session.room || current.revoked || current.expires <= clock()) fail('登录已过期，请重新配对相框', 401);
    if (current.role !== 'frame') fail('仅相框可更新活动状态', 403);
  }
  async function update(data, session) {
    const receivedAt = clock();
    if (session.role !== 'frame') fail('仅相框可更新活动状态', 403);
    if (!ACTIVITIES.has(data.activity)) fail('相框活动状态不正确');
    let messageId = null;
    if (data.activity === 'idle') {
      if (data.messageId !== undefined && data.messageId !== null && data.messageId !== '') fail('空闲状态不能关联记忆');
    } else {
      if (typeof data.messageId !== 'string' || data.messageId.length > 160) fail('记忆不存在', 404);
      const message = await store.get(data.messageId);
      if (!message || message.kind !== 'message' || message.room !== session.room || message.type !== 'photo' || message.deleted) fail('记忆不存在', 404);
      if (data.activity === 'listening' && !message.audio) fail('这份记忆没有原声');
      if (data.activity === 'spatial' && (await spatial.states(session.room))(message)?.status !== 'ready') fail('空间尚未准备好', 409);
      messageId = message._id;
    }
    const changed = await store.mutate(session._id, current => {
      checkSession(current, session);
      const previous = current.presence;
      // Older requests delayed by validation cannot overwrite a newer report.
      if (previous?.receivedAt > receivedAt) return null;
      if (previous?.activity === data.activity && previous?.messageId === messageId && clock() - previous.updatedAt < HEARTBEAT_MIN_INTERVAL) return null;
      return { ...current, lastSeen: clock(), presence: { activity: data.activity, messageId, receivedAt, updatedAt: clock() } };
    });
    const latest = changed || await store.get(session._id); checkSession(latest, session);
    const updatedAt = latest.presence.updatedAt;
    return { ok: true, accepted: Boolean(changed), updatedAt, expiresAt: Math.min(updatedAt + PRESENCE_TTL, latest.expires),
      retryAfterMs: Math.max(0, updatedAt + HEARTBEAT_MIN_INTERVAL - clock()) };
  }
  async function snapshot(members, messages, spatialState, mediaURL, session) {
    const { current, ...presence } = presentFrame(members, messages, spatialState, clock());
    const message = current ? { id: current._id, title: current.title || current.card?.title || '家人寄来的记忆',
      imageURL: current.image ? await mediaURL(current.image, session) : '', hasAudio: Boolean(current.audio) } : null;
    return { framePresence: { ...presence, message }, stats: familyStats(messages, spatialState) };
  }
  return { update, snapshot };
}
module.exports = { createFamilyState, familyStats, presentFrame, PRESENCE_TTL, HEARTBEAT_MIN_INTERVAL };
