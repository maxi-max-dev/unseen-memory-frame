'use strict';
const crypto = require('node:crypto');

const RING_TTL = 60000, CALL_TTL = 15 * 60000, PEER_TTL = 45000, HEARTBEAT_INTERVAL = 10000;
const RETENTION = 86400000, BUDGET_WINDOW = 10 * 60000, MAX_HISTORY = 20, MAX_ACTIVE = 2;
const MAX_CANDIDATES = 48, MAX_SDP_BYTES = 24 * 1024;
const ACTIVE = new Set(['ringing', 'accepted', 'connecting']);
const ROLES = new Set(['owner', 'family', 'frame']);
const ACTIONS = new Set(['callCapabilities', 'callState', 'callStart', 'callCancelStart', 'callAccept', 'callReject', 'callEnd', 'callIce', 'callSignal']);
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const idOK = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const identity = s => s.account || s._id;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Configuration is administrator supplied, never accepted from API bodies. No
// public ICE defaults and no static browser credentials. The shared secret stays
// in this server process and is used only to mint coturn REST credentials.
function configuration(env) {
  const disabled = reason => ({ enabled: false, reason });
  if (env.MEMORY_CALL_ENABLED !== '1') return disabled('家庭语音通话尚未启用');
  const raw = env.MEMORY_CALL_ICE_SERVERS_JSON;
  if (typeof raw !== 'string' || raw.length > 4096) return disabled('管理员尚未配置受控 TURN 中继');
  let values;
  try { values = JSON.parse(raw); } catch { return disabled('通话中继配置格式不正确，请联系管理员'); }
  if (!Array.isArray(values) || values.length < 1 || values.length > 4) return disabled('通话中继配置格式不正确，请联系管理员');
  const servers = []; let turns = 0, urlsCount = 0;
  for (const value of values) {
    if (!object(value) || Object.keys(value).some(key => key !== 'urls')) return disabled('中继配置只能包含受控 urls，凭据由服务端临时生成');
    const urls = typeof value.urls === 'string' ? [value.urls] : value.urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 4) return disabled('通话中继地址格式不正确，请联系管理员');
    const normalized = [];
    for (const url of urls) {
      if (typeof url !== 'string' || url.length > 256) return disabled('通话中继地址格式不正确，请联系管理员');
      const match = /^(stun|stuns|turn|turns):([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url);
      if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535)) || (++urlsCount > 8)) return disabled('通话中继地址格式不正确，请联系管理员');
      if (/^turns?$/i.test(match[1])) turns++;
      normalized.push(url);
    }
    servers.push({ urls: normalized });
  }
  if (!turns) return disabled('语音通话需要受控 TURN 中继，单独 STUN 不足以启用');
  const secret = env.MEMORY_CALL_TURN_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512) return disabled('管理员尚未配置有效的 TURN 临时凭据密钥');
  return { enabled: true, reason: '', servers, secret };
}

function capabilities(config) {
  return { enabled: config.enabled, audioCall: config.enabled, reason: config.reason, mode: 'webrtc-audio',
    requiresSecureContext: true, backgroundPush: false, pollIntervalMs: 1500, maxCallMs: CALL_TTL,
    maxCandidates: MAX_CANDIDATES, iceTransportPolicy: 'relay' };
}

function endCall(call, status, reason, time) {
  const { signals, heartbeat, ...rest } = call;
  // SDP and ICE can contain network addresses. Remove them immediately when a
  // terminal state is observed; never include them in general call listings.
  return { ...rest, status, reason, endedAt: time, updatedAt: time, revision: call.revision + 1 };
}

function createFamilyCall(store, { allowed, clock = Date.now, env = process.env } = {}) {
  if (typeof allowed !== 'function') throw new TypeError('Family call requires account authorization');

  async function authenticate(input) {
    const s = idOK(input?._id) ? await store.get(input._id) : null;
    if (!s || s.kind !== 'session' || s.revoked || s.expires <= clock() || s.room !== input.room ||
      s.role !== input.role || s.account !== input.account || !ROLES.has(s.role) || !await allowed(s)) fail('登录已失效，请重新登录或配对', 401);
    return s;
  }

  async function roster(s) {
    const list = await store.list('session', s.room), members = new Map(), sessions = new Map(), cache = new Map(), time = clock();
    for (const item of list) {
      if (item.kind !== 'session' || item.room !== s.room || item.revoked || item.expires <= time || !ROLES.has(item.role) || !await allowed(item, cache)) continue;
      sessions.set(item._id, item);
      const id = identity(item), recent = Number.isFinite(item.lastSeen) && item.lastSeen <= time && time - item.lastSeen < 45000;
      if (!members.has(id) || recent) members.set(id, { id, name: String(item.name || '家人').slice(0, 30), role: item.role, recentlySeen: recent });
    }
    return { members, sessions };
  }

  const bindingKey = call => [call.id, call.callerSession, call.calleeSession || '', call.from.id, call.to.id].join(':');

  async function validSession(s, room, expectedIdentity) {
    return !!s && s.kind === 'session' && s.room === room && !s.revoked && s.expires > clock() && ROLES.has(s.role) &&
      identity(s) === expectedIdentity && await allowed(s);
  }

  async function validIdentity(id, room) {
    const value = await store.get(id);
    if (value?.kind === 'account') return value.room === room && value.status === 'active' && !value.revoked && ROLES.has(value.role);
    return validSession(value, room, id);
  }

  async function invalidBindings(record, room) {
    const invalid = new Set();
    for (const call of record?.calls || []) {
      if (!ACTIVE.has(call.status)) continue;
      const caller = await store.get(call.callerSession);
      const callerAllowed = await validSession(caller, room, call.from.id);
      const calleeAllowed = call.calleeSession ? await validSession(await store.get(call.calleeSession), room, call.to.id) : await validIdentity(call.to.id, room);
      if (!callerAllowed || !calleeAllowed) invalid.add(bindingKey(call));
    }
    return invalid;
  }

  function normalized(old, invalid, time, room, config) {
    const calls = (old?.calls || []).filter(call => call.createdAt > time - RETENTION).map(call => {
      if (!ACTIVE.has(call.status)) return call;
      if (!config.enabled) return endCall(call, 'failed', 'service-disabled', time);
      // Never infer revocation from an earlier roster snapshot. The call may have
      // been created or accepted by a new session while this request was waiting.
      // Apply only a fresh invalidation checked for this exact device binding.
      if (invalid.has(bindingKey(call))) return endCall(call, 'failed', 'permission-revoked', time);
      if (call.expiresAt <= time) return endCall(call, 'expired', 'timeout', time);
      if (call.status !== 'ringing' && (time - call.heartbeat.caller > PEER_TTL || time - call.heartbeat.callee > PEER_TTL)) return endCall(call, 'failed', 'peer-left', time);
      return call;
    });
    // This compact tombstone ledger preserves start idempotency after a call has
    // left the 20-item visible history. Room rate limits bound it to <=1,740/day.
    const starts = (old?.starts || []).filter(item => item.createdAt > time - RETENTION);
    const budget = old?.budget && old.budget.since > time - BUDGET_WINDOW ? old.budget : { since: time, count: 0, senders: {} };
    return { _id: 'rtc_' + room, kind: 'familyCall', room, calls, starts, budget };
  }

  function side(call, s) {
    if (call.callerSession === s._id && call.from.id === identity(s)) return 'caller';
    if (call.calleeSession === s._id && call.to.id === identity(s)) return 'callee';
    return null;
  }

  function findCall(record, id, s) {
    const call = record.calls.find(item => item.id === id), me = identity(s);
    if (!call || (call.from.id !== me && call.to.id !== me)) fail('通话不存在或无权访问', 404);
    return call;
  }

  function present(call, s, signals = false) {
    const mine = side(call, s), me = identity(s);
    const { callerSession, calleeSession, heartbeat, signals: storedSignals, startKey, ...metadata } = call;
    return { ...metadata, direction: call.from.id === me ? 'outgoing' : 'incoming', canControl: !!mine,
      ...(signals && mine && storedSignals && call.status !== 'ringing' ? { peer: structuredClone(storedSignals[mine === 'caller' ? 'callee' : 'caller']) } : {}) };
  }

  function response(record, id, s) {
    const call = findCall(record, id, s);
    return { callId: call.id, call: present(call, s, true), serverTime: clock() };
  }

  function cleanDescription(value) {
    if (!object(value) || !['offer', 'answer'].includes(value.type) || typeof value.sdp !== 'string' ||
      Buffer.byteLength(value.sdp) > MAX_SDP_BYTES || !value.sdp.startsWith('v=0') || /\0/.test(value.sdp)) fail('通话描述格式不正确或超过限制');
    // This feature is audio only: disallow video/data channels and arbitrary SDP
    // payload storage. Browser WebRTC performs the full protocol validation.
    const lines = value.sdp.split(/\r?\n/), media = lines.filter(line => line.startsWith('m='));
    if (media.length !== 1 || !/^m=audio\s/.test(media[0])) fail('家庭通话目前仅支持一路音频');
    const mid = lines.find(line => line.startsWith('a=mid:'))?.slice(6) ?? null;
    const ufrag = lines.find(line => line.startsWith('a=ice-ufrag:'))?.slice(12);
    const inline = lines.filter(line => line.startsWith('a=candidate:')).map(line => cleanCandidate({
      candidate: line.slice(2), sdpMid: mid, sdpMLineIndex: 0, ...(ufrag ? { usernameFragment: ufrag } : {}) }));
    if (new Set(inline.map(item => item.candidate)).size > MAX_CANDIDATES) fail('通话网络候选超过限制', 429);
    // Normalize inline candidates into the same bounded trickle list. Peers then
    // apply every candidate once, and SDP cannot bypass the relay/count checks.
    return { description: { type: value.type, sdp: lines.filter(line => !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates').join('\r\n') },
      candidates: inline, iceComplete: lines.includes('a=end-of-candidates') };
  }

  function cleanCandidate(value) {
    if (!object(value) || typeof value.candidate !== 'string' || !value.candidate.startsWith('candidate:') ||
      Buffer.byteLength(value.candidate) > 1024 || /[\r\n\0]/.test(value.candidate)) fail('通话网络候选格式不正确');
    if (value.sdpMid != null && (typeof value.sdpMid !== 'string' || value.sdpMid.length > 64 || /[\r\n\0]/.test(value.sdpMid))) fail('通话网络候选格式不正确');
    if (value.sdpMLineIndex != null && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 16)) fail('通话网络候选格式不正确');
    if (value.sdpMid == null && value.sdpMLineIndex == null) fail('通话网络候选缺少音频轨道');
    if (value.usernameFragment != null && (typeof value.usernameFragment !== 'string' || value.usernameFragment.length > 256 || /[\r\n\0]/.test(value.usernameFragment))) fail('通话网络候选格式不正确');
    const fields = value.candidate.trim().split(/ +/);
    if (fields.length < 8 || !/^candidate:[a-zA-Z0-9+/]{1,32}$/.test(fields[0]) || !/^[12]$/.test(fields[1]) || !/^(udp|tcp)$/i.test(fields[2]) ||
      !/^\d{1,10}$/.test(fields[3]) || Number(fields[3]) > 0xffffffff || !/^[a-zA-Z0-9.:[\]_-]{1,255}$/.test(fields[4]) ||
      !/^\d{1,5}$/.test(fields[5]) || Number(fields[5]) < 1 || Number(fields[5]) > 65535 || fields[6] !== 'typ' ||
      (fields.length - 8) % 2 !== 0) fail('通话网络候选格式不正确');
    if (fields[7] !== 'relay') fail('请使用已配置的 TURN 中继候选');
    for (let i = 8; i < fields.length; i += 2) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fields[i]) || fields[i] === 'typ' || !/^[^\s]{1,256}$/.test(fields[i + 1])) fail('通话网络候选扩展格式不正确');
    }
    // SDP/ICE still carry network metadata; only the bound peer may read it.
    return { candidate: fields.join(' '), sdpMid: value.sdpMid ?? null, sdpMLineIndex: value.sdpMLineIndex ?? null,
      ...(value.usernameFragment == null ? {} : { usernameFragment: value.usernameFragment }) };
  }

  async function handle(action, data, input) {
    if (!ACTIONS.has(action)) fail('未知的家庭通话操作', 404);
    if (!object(data)) fail('家庭通话请求格式不正确');
    const s = await authenticate(input), config = configuration(env), cap = capabilities(config);
    if (action === 'callCapabilities') return cap;
    const family = await roster(s), me = identity(s), time = clock(), docId = 'rtc_' + s.room;
    if (!family.members.has(me)) fail('登录已失效，请重新登录或配对', 401);
    const existing = await store.get(docId), invalid = await invalidBindings(existing, s.room);
    if (action === 'callState') {
      if (data.id !== undefined && !idOK(data.id)) fail('通话不存在或无权访问', 404);
      const old = existing, record = normalized(old, invalid, time, s.room, config);
      const selected = data.id ? findCall(record, data.id, s) : null, mine = selected && side(selected, s);
      const heartbeatDue = selected && mine && ACTIVE.has(selected.status) && selected.status !== 'ringing' && time - selected.heartbeat[mine] >= HEARTBEAT_INTERVAL;
      let saved = record;
      if (old && (heartbeatDue || JSON.stringify(old.calls) !== JSON.stringify(record.calls) || (old.starts || []).length !== record.starts.length)) {
        saved = await store.mutate(docId, latest => {
          const next = normalized(latest, invalid, clock(), s.room, config);
          if (data.id) {
            const item = findCall(next, data.id, s), participant = side(item, s);
            if (participant && ACTIVE.has(item.status) && item.status !== 'ringing') item.heartbeat[participant] = clock();
          }
          return next;
        });
      }
      return { capabilities: cap, members: [...family.members.values()].filter(item => item.id !== me),
        calls: saved.calls.filter(call => call.from.id === me || call.to.id === me).sort((a, b) => b.createdAt - a.createdAt).map(call => present(call, s)),
        ...(data.id ? { call: present(findCall(saved, data.id, s), s, true) } : {}), serverTime: clock() };
    }
    if (!config.enabled && !['callEnd', 'callReject', 'callCancelStart'].includes(action)) fail(config.reason, 503);
    if (action === 'callIce') {
      if (!idOK(data.id)) fail('通话不存在或无权访问', 404);
      const record = normalized(existing, invalid, time, s.room, config), call = findCall(record, data.id, s);
      if (!side(call, s)) fail('请在发起或接听通话的设备操作', 403);
      if (!['accepted', 'connecting'].includes(call.status)) fail('请等待家人接听，或重新发起通话', 409);
      const expiresAt = call.expiresAt + 60000, username = Math.ceil(expiresAt / 1000) + ':' + digest(call.id + ':' + s._id).slice(0, 24);
      const credential = crypto.createHmac('sha1', config.secret).update(username).digest('base64');
      return { iceServers: config.servers.map(server => ({ urls: server.urls,
        ...(server.urls.some(url => /^turns?:/i.test(url)) ? { username, credential } : {}) })), iceTransportPolicy: 'relay', expiresAt };
    }
    let target, startKey, description, candidates = [], inlineComplete = false;
    if (action === 'callStart') {
      if (!idOK(data.targetId) || !idOK(data.requestId) || data.requestId.length < 8) fail('请选择家庭成员并重试');
      target = family.members.get(data.targetId);
      if (!target || !await validIdentity(target.id, s.room)) fail('这位成员已离开家庭或登录已失效', 404);
      if (target.id === me) fail('请选择另一位家庭成员');
      startKey = digest(me + ':' + data.requestId);
    } else if (action === 'callCancelStart') {
      if (!idOK(data.requestId) || data.requestId.length < 8) fail('呼叫请求标识不正确');
      startKey = digest(me + ':' + data.requestId);
    } else if (!idOK(data.id)) fail('通话不存在或无权访问', 404);
    if (action === 'callEnd' && data.reason !== undefined && !['hangup', 'failed', 'cancelled'].includes(data.reason)) fail('通话结束原因不正确');
    if (action === 'callSignal') {
      if (data.description !== undefined) {
        const parsed = cleanDescription(data.description); description = parsed.description; candidates = parsed.candidates; inlineComplete = parsed.iceComplete;
      }
      if (data.candidates !== undefined) {
        if (!Array.isArray(data.candidates) || data.candidates.length > 8) fail('每次最多提交 8 条网络候选');
        candidates.push(...data.candidates.map(cleanCandidate));
      }
      if (data.iceComplete !== undefined && data.iceComplete !== true) fail('网络候选完成标记不正确');
      if (!description && !candidates?.length && !data.iceComplete) fail('缺少通话协商内容');
    }
    await authenticate(s);
    const result = await store.mutate(docId, old => {
      const currentTime = clock(), record = normalized(old, invalid, currentTime, s.room, config);
      if (action === 'callCancelStart') {
        let entry = record.starts.find(item => item.key === startKey);
        const call = record.calls.find(item => item.startKey === startKey);
        if ((entry?.callerSession && entry.callerSession !== s._id) || (call && call.callerSession !== s._id)) fail('请在发起呼叫的设备取消', 403);
        if (!entry) {
          if (record.budget.count >= 12 || (record.budget.senders[me] || 0) >= 4) fail('取消请求过于频繁，请稍后重试', 429);
          entry = { key: startKey, targetId: null, callerSession: s._id, createdAt: currentTime, cancelled: true };
          record.starts.push(entry); record.budget.count++; record.budget.senders[me] = (record.budget.senders[me] || 0) + 1;
        } else entry.cancelled = true;
        if (call && ACTIVE.has(call.status)) record.calls[record.calls.indexOf(call)] = endCall(call, 'ended', 'cancelled', currentTime);
        return record;
      }
      if (action === 'callStart') {
        const duplicate = record.starts.find(item => item.key === startKey);
        if (duplicate) {
          if (duplicate.cancelled) fail('本次呼叫已取消，请重新发起', 409);
          if (duplicate.targetId !== target.id) fail('同一次呼叫不能更换家庭成员', 409);
          if (!record.calls.some(call => call.startKey === startKey)) fail('这次呼叫已经结束，请重新发起', 409);
          return record;
        }
        const active = record.calls.filter(call => ACTIVE.has(call.status));
        if (active.some(call => [call.from.id, call.to.id].some(id => id === me || id === target.id))) fail('你或这位家人已有通话，请结束后重试', 409);
        if (active.length >= MAX_ACTIVE) fail('家庭同时通话已达上限，请稍后再试', 429);
        if (record.budget.count >= 12 || (record.budget.senders[me] || 0) >= 4) fail('呼叫过于频繁，请 10 分钟后再试', 429);
        while (record.calls.length >= MAX_HISTORY) {
          const index = record.calls.findIndex(call => !ACTIVE.has(call.status));
          if (index < 0) fail('家庭通话记录已满，请稍后再试', 429);
          record.calls.splice(index, 1);
        }
        record.starts.push({ key: startKey, targetId: target.id, callerSession: s._id, createdAt: currentTime });
        record.budget.count++; record.budget.senders[me] = (record.budget.senders[me] || 0) + 1;
        const from = family.members.get(me), empty = () => ({ description: null, candidates: [], iceComplete: false });
        record.calls.push({ id: 'call_' + startKey.slice(0, 40), startKey, from: { id: me, name: from.name }, to: { id: target.id, name: target.name },
          callerSession: s._id, calleeSession: null, status: 'ringing', createdAt: currentTime, updatedAt: currentTime,
          ringExpiresAt: currentTime + RING_TTL, expiresAt: currentTime + RING_TTL, revision: 1,
          signals: { caller: empty(), callee: empty() }, heartbeat: { caller: currentTime, callee: currentTime } });
        return record;
      }
      const call = findCall(record, data.id, s), index = record.calls.indexOf(call), participant = side(call, s);
      if (action === 'callAccept') {
        if (call.to.id !== me) fail('只有被呼叫的家人可以接听', 403);
        if (call.calleeSession === s._id && ['accepted', 'connecting'].includes(call.status)) return record;
        if (call.status !== 'ringing') fail('通话已被其他设备接听、结束或过期', 409);
        call.calleeSession = s._id; call.status = 'accepted'; call.acceptedAt = currentTime; call.expiresAt = currentTime + CALL_TTL;
        call.heartbeat = { caller: currentTime, callee: currentTime }; call.updatedAt = currentTime; call.revision++;
      } else if (action === 'callReject') {
        if (call.to.id !== me) fail('只有被呼叫的家人可以拒接', 403);
        if (call.status === 'declined') return record;
        if (call.status === 'ringing') record.calls[index] = endCall(call, 'declined', 'declined', currentTime);
        else if (call.calleeSession === s._id) {
          // The accept may have committed even when its HTTP response was lost.
          // A close action based on the older ringing UI must still release the
          // exact device that accepted; sibling sessions cannot end its call.
          if (ACTIVE.has(call.status)) record.calls[index] = endCall(call, 'ended', 'cancelled', currentTime);
        } else fail('通话已被其他设备接听、结束或过期', 409);
      } else if (action === 'callEnd') {
        if (!participant) fail('请在发起或接听通话的设备操作', 403);
        if (!ACTIVE.has(call.status)) return record;
        record.calls[index] = endCall(call, data.reason === 'failed' ? 'failed' : 'ended', data.reason || 'hangup', currentTime);
      } else {
        if (!participant) fail('请在发起或接听通话的设备操作', 403);
        if (!['accepted', 'connecting'].includes(call.status)) fail('通话尚未接听、已结束或已过期', 409);
        const signals = call.signals[participant]; let changed = false;
        if (description) {
          if (description.type !== (participant === 'caller' ? 'offer' : 'answer')) fail('当前设备不能提交这种通话描述', 403);
          if (description.type === 'answer' && !call.signals.caller.description) fail('请先等待对方的通话描述', 409);
          if (signals.description && JSON.stringify(signals.description) !== JSON.stringify(description)) fail('通话描述已确定，请结束后重新发起', 409);
          if (!signals.description) { signals.description = description; changed = true; }
        }
        for (const candidate of candidates || []) {
          if (signals.candidates.some(item => item.candidate.candidate === candidate.candidate)) continue;
          if (signals.iceComplete) fail('网络候选已完成，请重新发起通话', 409);
          if (signals.candidates.length >= MAX_CANDIDATES) fail('通话网络候选超过限制', 429);
          signals.candidates.push({ seq: signals.candidates.length + 1, candidate }); changed = true;
        }
        if ((data.iceComplete || inlineComplete) && !signals.iceComplete) { signals.iceComplete = true; changed = true; }
        if (changed) { call.status = 'connecting'; call.updatedAt = currentTime; call.revision++; }
        call.heartbeat[participant] = currentTime;
      }
      return record;
    });
    if (action === 'callCancelStart') {
      const call = result.calls.find(item => item.startKey === startKey);
      return { cancelled: true, callId: call?.id || null, call: call ? present(call, s) : null, serverTime: clock() };
    }
    return response(result, action === 'callStart' ? 'call_' + startKey.slice(0, 40) : data.id, s);
  }
  return { handle };
}

module.exports = { createFamilyCall, RING_TTL, CALL_TTL, PEER_TTL, RETENTION, MAX_CANDIDATES, MAX_SDP_BYTES, MAX_HISTORY };
