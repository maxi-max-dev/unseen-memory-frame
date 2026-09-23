'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const usernameOK = value => /^[a-z0-9._-]{3,32}$/.test(value);
const passwordOK = value => typeof value === 'string' && value.length >= 8 && value.length <= 128;
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const BAD_LOGIN = '账号或密码不正确，或账号已被移除';

function createAccounts(store, { setupCode, issue, clock = Date.now }) {
  const dummySalt = crypto.randomBytes(16).toString('hex');
  async function derive(password, salt) { return scrypt(password, Buffer.from(salt, 'hex'), 64, SCRYPT); }
  async function checkPassword(password, account) {
    const valid = passwordOK(password), credential = account?.credential;
    const usable = credential?.version === 1 && /^[a-f0-9]{32}$/.test(credential.salt) && /^[a-f0-9]{128}$/.test(credential.digest);
    const digest = await derive(valid ? password : 'invalid-password', usable ? credential.salt : dummySalt);
    return Boolean(valid && usable && crypto.timingSafeEqual(digest, Buffer.from(credential.digest, 'hex')));
  }
  // A single bounded CAS document makes throttling effective across CloudBase instances.
  // Successful authentication clears only that username's counter, never the global budget.
  async function throttle(username) {
    const time = clock(), userKey = hash(username.slice(0, 128));
    const budget = await store.mutate('auth_budget', old => {
      const global = old?.global && time - old.global.since < 60000 ? old.global : { since: time, count: 0 };
      const users = Object.fromEntries(Object.entries(old?.users || {}).filter(([, value]) => time - value.since < 900000));
      if (global.count >= 60) fail('登录或注册过于频繁，请稍后再试', 429);
      const user = users[userKey] || { since: time, count: 0 };
      return { _id: 'auth_budget', kind: 'authBudget', global: { ...global, count: global.count + 1 },
        users: { ...users, [userKey]: { ...user, count: user.count + 1 } } };
    });
    if (budget.users[userKey].count > 10) fail('该账号尝试次数过多，请 15 分钟后再试', 429);
    return userKey;
  }
  async function succeeded(userKey) {
    await store.mutate('auth_budget', old => {
      if (!old?.users?.[userKey]) return null;
      const users = { ...old.users }; delete users[userKey]; return { ...old, users };
    });
  }
  async function invitation(value) {
    if (!/^[a-f0-9]{48}$/.test(value || '')) fail('邀请链接不完整');
    const invite = await store.get('i_' + hash(value));
    if (!invite || invite.kind !== 'invite' || invite.revoked || invite.expires <= clock()) fail('邀请已失效，请家人重新生成');
    if (invite.role !== 'family') fail('相框配对邀请不能用于注册家人账号', 403);
    if (!await store.get('r_' + invite.room)) fail('家庭不存在', 404);
    return invite;
  }
  async function validateRegistration(data) {
    if (data.mode === 'create') {
      const candidate = clean(data.setupCode, 100);
      if (!setupCode || !crypto.timingSafeEqual(Buffer.from(hash(candidate)), Buffer.from(hash(setupCode)))) fail('开通码不正确', 403);
      return { mode: 'create', room: crypto.randomUUID(), role: 'owner', roomName: clean(data.name, 40) || '我们的家' };
    }
    if (data.mode === 'join') {
      const invite = await invitation(data.invite);
      return { mode: 'join', room: invite.room, role: 'family', inviteId: invite._id };
    }
    fail('请选择创建家庭或使用家人邀请注册');
  }
  async function createRoom(room, name, createdAt = clock()) {
    const existing = await store.list('room');
    await store.mutate('account_room_registry', old => {
      const rooms = [...new Set([...(old?.rooms || []), ...existing.map(item => item.room)])];
      if (!rooms.includes(room)) {
        if (rooms.length >= 10) fail('本次 Demo 最多创建 10 个家庭');
        rooms.push(room);
      }
      return { _id: 'account_room_registry', kind: 'roomRegistry', rooms };
    });
    return store.mutate('r_' + room, old => old || { _id: 'r_' + room, kind: 'room', room, name, createdAt });
  }
  // Fixed room IDs and a pending credential document make a write failure retryable.
  // Every concurrent recovery writes the same room and never replaces the first credentials.
  async function complete(account) {
    if (account.status === 'active') return account;
    if (account.revoked || account.status !== 'pending') fail(BAD_LOGIN, 401);
    if (account.mode === 'join') {
      const invite = await store.get(account.inviteId);
      if (!invite || invite.revoked || invite.role !== 'family' || invite.room !== account.room || invite.expires <= clock()) fail('邀请已失效，请联系家庭创建者', 403);
    } else {
      // Reserve the room before writing it. Reservations survive a failed write and are
      // reusable by this pending account, preventing parallel registrations exceeding 10.
      await createRoom(account.room, account.roomName, account.createdAt);
    }
    if (!await store.get('r_' + account.room)) fail('家庭不存在', 404);
    return store.mutate(account._id, current => {
      if (!current || current.revoked || !['pending', 'active'].includes(current.status)) fail(BAD_LOGIN, 401);
      return { ...current, status: 'active', activatedAt: current.activatedAt || clock() };
    });
  }
  async function emit(account, key) {
    await succeeded(key);
    // session() also checks the account on every request, closing a concurrent revoke race.
    return issue(account.room, account.role, account.name, { account: account._id, username: account.username });
  }
  async function register(data) {
    const username = normalize(data.username), key = await throttle(username);
    if (!usernameOK(username)) fail('账号需为 3–32 位字母、数字、点、下划线或短横线');
    if (!passwordOK(data.password)) fail('密码需为 8–128 个字符');
    const grant = await validateRegistration(data), id = 'u_' + hash(username);
    let account = await store.get(id);
    if (!account) {
      const salt = crypto.randomBytes(16).toString('hex'), digest = (await derive(data.password, salt)).toString('hex');
      account = await store.mutate(id, old => old || { _id: id, kind: 'account', status: 'pending', username,
        name: clean(data.nickname, 30) || username, ...grant, credential: { version: 1, salt, digest }, createdAt: clock() });
    }
    if (!await checkPassword(data.password, account)) fail('账号已存在，请登录或换一个账号名', 409);
    if (account.revoked) fail(BAD_LOGIN, 401);
    // Same-password retries are idempotent only for the original registration intent.
    if (account.mode !== grant.mode || (grant.mode === 'join' && account.room !== grant.room)) fail('账号已绑定其他家庭，请直接登录', 409);
    if (account.status === 'pending' && grant.mode === 'join' && account.inviteId !== grant.inviteId) {
      account = await store.mutate(account._id, current => {
        if (!current || current.revoked) fail(BAD_LOGIN, 401);
        return current.status === 'pending' ? { ...current, inviteId: grant.inviteId } : current;
      });
    }
    return emit(await complete(account), key);
  }
  async function login(data) {
    const username = normalize(data.username), key = await throttle(username);
    let account = usernameOK(username) ? await store.get('u_' + hash(username)) : null;
    if (!await checkPassword(data.password, account) || !account || account.kind !== 'account' || account.revoked) fail(BAD_LOGIN, 401);
    if (data.invite) {
      const invite = await invitation(data.invite);
      if (invite.room !== account.room) fail('这个账号不属于邀请中的家庭，请使用对应账号或注册新账号', 403);
      if (account.status === 'pending' && account.mode === 'join' && account.inviteId !== invite._id) {
        account = await store.mutate(account._id, current => {
          if (!current || current.revoked) fail(BAD_LOGIN, 401);
          return current.status === 'pending' ? { ...current, inviteId: invite._id } : current;
        });
      }
    }
    return emit(await complete(account), key);
  }
  async function allowed(session, requestCache) {
    if (!session.account) return true;
    if (requestCache && !requestCache.has(session.account)) requestCache.set(session.account, store.get(session.account));
    const account = await (requestCache ? requestCache.get(session.account) : store.get(session.account));
    return Boolean(account?.kind === 'account' && account.status === 'active' && !account.revoked && account.room === session.room && account.role === session.role);
  }
  async function revoke(target, caller) {
    if (target.account && target.account === caller.account) fail('不能移除当前账号，请使用退出登录');
    if (target.account) {
      await store.mutate(target.account, current => {
        if (!current || current.kind !== 'account' || current.room !== caller.room) fail('账号不存在');
        return { ...current, revoked: true, revokedAt: clock() };
      });
      // The tombstone above is authoritative even if a later session update fails.
      const sessions = await store.list('session', caller.room);
      for (const member of sessions.filter(member => member.account === target.account)) {
        await store.mutate(member._id, current => current ? { ...current, revoked: true } : null);
      }
    } else await store.mutate(target._id, current => current ? { ...current, revoked: true } : null);
  }
  return { register, login, allowed, revoke, createRoom };
}
module.exports = { createAccounts };
