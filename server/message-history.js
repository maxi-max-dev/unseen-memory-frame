'use strict';
const crypto = require('node:crypto');
const RECENT_LIMIT = 150, DEFAULT_LIMIT = 50, MAX_HISTORY_IDS = 300;
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const compare = (a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
const signature = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

function historyIds(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_HISTORY_IDS || !value.every(validId)) fail('历史记忆标识不正确');
  return new Set(value);
}

function createMessageHistory(store) {
  const secrets = new Map();
  async function secret(room) {
    if (secrets.has(room)) return secrets.get(room);
    let record = await store.get('r_' + room);
    if (!record?.historyCursorSecret) {
      // Persist with CAS so concurrent cold starts use the same signing key.
      record = await store.mutate('r_' + room, current => {
        if (!current || current.kind !== 'room' || current.room !== room) fail('家庭不存在');
        return current.historyCursorSecret ? current : { ...current, historyCursorSecret: crypto.randomBytes(32).toString('hex') };
      });
    }
    if (!record || record.kind !== 'room' || record.room !== room || !/^[a-f0-9]{64}$/.test(record.historyCursorSecret)) throw new Error('Invalid history cursor key');
    secrets.set(room, record.historyCursorSecret);
    return record.historyCursorSecret;
  }
  async function encode(room, message) {
    const payload = Buffer.from(JSON.stringify([1, room, message.createdAt, message._id])).toString('base64url');
    return payload + '.' + signature(await secret(room), payload);
  }
  async function decode(room, cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return null;
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(cursor)) fail('历史分页标识已失效，请刷新后重试');
    const [payload, mac] = cursor.split('.'), bytes = Buffer.from(payload, 'base64url');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('历史分页标识已失效，请刷新后重试'); }
    if (bytes.toString('base64url') !== payload || !Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== room ||
      !Number.isSafeInteger(value[2]) || value[2] < 0 || !validId(value[3]) || JSON.stringify(value) !== bytes.toString('utf8')) fail('历史分页标识已失效，请刷新后重试');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(signature(await secret(room), payload)))) fail('历史分页标识已失效，请刷新后重试');
    return { createdAt: value[2], _id: value[3] };
  }
  async function page(messages, room, { cursor, limit = DEFAULT_LIMIT } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_LIMIT) fail('每页记忆数量需为 1–150 条');
    const before = await decode(room, cursor);
    // Scope before selecting or hydrating. A cursor only supplies an ordering
    // boundary; it never supplies the family or a record to fetch by ID.
    const visible = messages.filter(message => message.kind === 'message' && message.room === room && !message.deleted).sort(compare);
    const candidates = before ? visible.filter(message => compare(message, before) < 0) : visible;
    const items = candidates.slice(-limit), hasMore = candidates.length > items.length;
    return { messages: items, nextCursor: hasMore ? await encode(room, items[0]) : null, hasMore, total: visible.length };
  }
  return { page };
}

module.exports = { createMessageHistory, historyIds, compare, RECENT_LIMIT };
