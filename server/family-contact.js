'use strict';
const crypto = require('node:crypto');

const PENDING_TTL = 5 * 60000, ACK_TTL = 30 * 60000, RETENTION = 86400000;
const BUDGET_WINDOW = 10 * 60000, MAX_ENTRIES = 40;
const ACTIVE = new Set(['pending', 'acknowledged']);
const ROLES = new Set(['owner', 'family', 'frame']);
const ACTIONS = new Set(['contactState', 'contactRequest', 'contactRespond', 'contactEnd']);
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const identity = s => s.account || s._id;

function createFamilyContact(store, { allowed, clock = Date.now } = {}) {
  if (typeof allowed !== 'function') throw new TypeError('Family contact requires account authorization');

  async function authenticate(s) {
    const current = validId(s?._id) ? await store.get(s._id) : null;
    if (!current || current.kind !== 'session' || current.room !== s.room || current.role !== s.role ||
      current.account !== s.account || current.revoked || current.expires <= clock() || !ROLES.has(current.role) || !await allowed(current)) {
      fail('登录已失效，请重新登录或配对', 401);
    }
    return current;
  }

  async function roster(s) {
    const [sessions, accounts] = await Promise.all([store.list('session', s.room), store.list('account', s.room)]);
    const members = new Map(), cache = new Map(), time = clock();
    // Registered membership survives ordinary logout. It is not presence: these
    // members are shown as possibly offline until an authorized session reports.
    for (const account of accounts) {
      if (account.kind !== 'account' || account.room !== s.room || account.status !== 'active' || account.revoked || !ROLES.has(account.role)) continue;
      members.set(account._id, { id: account._id, name: String(account.name || account.username || '家人').slice(0, 30), role: account.role, recentlySeen: false });
    }
    for (const member of sessions) {
      if (member.kind !== 'session' || member.room !== s.room || member.revoked || member.expires <= time || !ROLES.has(member.role) || !await allowed(member, cache)) continue;
      const id = identity(member), previous = members.get(id);
      const recent = Number.isFinite(member.lastSeen) && member.lastSeen <= time && time - member.lastSeen < 45000;
      const item = { id, name: String(member.name || '家人').slice(0, 30), role: member.role, recentlySeen: recent };
      if (!previous || recent) members.set(id, item);
    }
    return members;
  }

  function normalized(old, members, time, room) {
    const entries = (old?.entries || []).filter(item => item.createdAt > time - RETENTION).map(item => {
      if (!ACTIVE.has(item.status)) return item;
      if (item.expiresAt <= time) return { ...item, status: 'expired', updatedAt: time };
      return item;
    });
    const budget = old?.budget && old.budget.since > time - BUDGET_WINDOW ? old.budget : { since: time, count: 0, senders: {} };
    return { _id: 'fc_' + room, kind: 'familyContact', room, entries, budget };
  }

  function present(record, s, members, time) {
    const me = identity(s);
    const requests = record.entries.filter(item => item.from.id === me || item.to.id === me)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      // Membership is a request-local projection, not a permanent state change.
      // A CAS retry may see a new call/member created after this roster snapshot;
      // absence in that older snapshot must never destroy the newer request.
      .map(({ requestKey, ...item }) => ({ ...item,
        ...(ACTIVE.has(item.status) && (!members.has(item.from.id) || !members.has(item.to.id)) ? { status: 'unavailable' } : {}),
        direction: item.to.id === me ? 'incoming' : 'outgoing' }));
    return { members: [...members.values()].filter(item => item.id !== me), requests,
      incomingCount: requests.filter(item => item.direction === 'incoming' && item.status === 'pending').length,
      mode: 'request-only', audioCall: false, backgroundPush: false, serverTime: time };
  }

  async function handle(action, data, session) {
    if (!ACTIONS.has(action)) fail('未知的家庭联系操作', 404);
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('联系请求格式不正确');
    const s = await authenticate(session), members = await roster(s), me = identity(s), time = clock(), docId = 'fc_' + s.room;
    if (!members.has(me)) fail('登录已失效，请重新登录或配对', 401);
    if (action === 'contactState') {
      const old = await store.get(docId), current = normalized(old, members, time, s.room);
      // Reads do not create documents or write for every poll; persist expiry
      // only. Authorization availability is projected from the current roster.
      if (old && JSON.stringify(old.entries) !== JSON.stringify(current.entries)) {
        const saved = await store.mutate(docId, latest => normalized(latest, members, clock(), s.room));
        return present(saved, s, members, clock());
      }
      return present(current, s, members, time);
    }
    let requestKey, target;
    if (action === 'contactRequest') {
      if (!validId(data.targetId) || !validId(data.requestId) || data.requestId.length < 8) fail('请选择家人并重试');
      target = members.get(data.targetId);
      if (!target) fail('这位成员已离开家庭或登录已失效', 404);
      if (target.id === me) fail('请选择另一位家庭成员');
      requestKey = crypto.createHash('sha256').update(me + ':' + data.requestId).digest('hex');
    } else if (!validId(data.id)) fail('联系请求不存在', 404);
    if (action === 'contactRespond' && !['acknowledge', 'decline'].includes(data.response)) fail('请选择确认收到或婉拒');
    // Recheck after the roster read, before any mutation. All mutations share one CAS
    // record so duplicate requests and rate limits apply across server instances.
    await authenticate(s);
    const result = await store.mutate(docId, old => {
      const currentTime = clock(), record = normalized(old, members, currentTime, s.room);
      if (action === 'contactRequest') {
        const duplicate = record.entries.find(item => item.requestKey === requestKey);
        if (duplicate) {
          if (duplicate.to.id !== target.id) fail('同一次联系请求不能更换成员', 409);
          return record;
        }
        const active = record.entries.filter(item => ACTIVE.has(item.status));
        if (active.some(item => (item.from.id === me && item.to.id === target.id) || (item.from.id === target.id && item.to.id === me))) fail('你们已有待处理的联系请求，请先处理或结束', 409);
        if (active.filter(item => item.from.id === me).length >= 3 || active.filter(item => item.to.id === target.id).length >= 5) fail('待处理联系较多，请稍后再试', 429);
        if (record.budget.count >= 30 || (record.budget.senders[me] || 0) >= 6) fail('联系过于频繁，请 10 分钟后再试', 429);
        if (record.entries.length >= MAX_ENTRIES) {
          const removable = record.entries.findIndex(item => !ACTIVE.has(item.status));
          if (removable < 0) fail('家庭联系列表已满，请稍后再试', 429);
          record.entries.splice(removable, 1);
        }
        record.budget.count++;
        record.budget.senders[me] = (record.budget.senders[me] || 0) + 1;
        const from = members.get(me);
        record.entries.push({ id: 'c_' + requestKey.slice(0, 40), requestKey,
          from: { id: from.id, name: from.name }, to: { id: target.id, name: target.name },
          status: 'pending', createdAt: currentTime, updatedAt: currentTime, expiresAt: currentTime + PENDING_TTL });
        return record;
      }
      const index = record.entries.findIndex(item => item.id === data.id), item = record.entries[index];
      if (!item || (item.from.id !== me && item.to.id !== me)) fail('联系请求不存在', 404);
      if (action === 'contactRespond') {
        if (item.to.id !== me) fail('只有收到请求的家人可以回应', 403);
        if (!members.has(item.from.id) || !members.has(item.to.id)) fail('联系成员已离开家庭或登录已失效', 409);
        const status = data.response === 'acknowledge' ? 'acknowledged' : 'declined';
        if (item.status === status) return record;
        if (item.status !== 'pending') fail('这条联系请求已结束或过期', 409);
        record.entries[index] = { ...item, status, updatedAt: currentTime,
          ...(status === 'acknowledged' ? { acknowledgedAt: currentTime, expiresAt: currentTime + ACK_TTL } : {}) };
      } else {
        if (!ACTIVE.has(item.status)) return record;
        if (item.status === 'pending' && item.to.id === me) fail('请使用婉拒回应这条联系请求', 403);
        record.entries[index] = { ...item, status: item.status === 'pending' ? 'cancelled' : 'ended', updatedAt: currentTime };
      }
      return record;
    });
    return present(result, s, members, clock());
  }
  return { handle };
}

module.exports = { createFamilyContact, PENDING_TTL, ACK_TTL, RETENTION, MAX_ENTRIES };
