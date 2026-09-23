'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalStore, CloudStore } = require('./store');
const { transcribe, summarize } = require('./ai');
const { createConversation } = require('./ai-conversation');
const { createRealtime } = require('./ai-realtime');
const { createFamilyContact } = require('./family-contact');
const { createActions } = require('./ai-actions');
const { createFamilyCall } = require('./family-call');
const { createSpatial } = require('./spatial');
const { createFamilyState } = require('./family-state');
const { createAccounts } = require('./accounts');
const { createPresence, ACTIONS: PRESENCE_ACTIONS, MAX_BODY_BYTES: PRESENCE_BODY_BYTES } = require('./presence');
const { createMessageHistory, historyIds, compare: compareMessages, RECENT_LIMIT } = require('./message-history');
const { parseRange } = require('./spatial-range');
const { pipeline } = require('node:stream/promises');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const random = () => crypto.randomBytes(24).toString('hex');
const uid = () => crypto.randomUUID();
const text = (x, n = 3000) => typeof x === 'string' ? x.trim().slice(0, n) : '';
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,90}$/.test(x);
const safeEqual = (a, b) => { const aa = hash(a), bb = hash(b); return crypto.timingSafeEqual(Buffer.from(aa), Buffer.from(bb)); };
const now = () => Date.now();
const PUBLIC = path.join(__dirname, 'public');
const MIMES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

async function createApp(options = {}) {
  const env = process.env.MEMORY_CLOUDBASE_ENV;
  const store = options.store || (env ? new CloudStore(env) : new LocalStore(options.dataDir || path.join(__dirname, '..', '.data')));
  await store.init();
  const spatial = createSpatial(store, options.spatial);
  const familyState = createFamilyState(store, spatial, options.familyState);
  const messageHistory = createMessageHistory(store);
  let setupCode = options.setupCode || process.env.DEMO_SETUP_CODE;
  if (!setupCode && !env) {
    const f = path.join(store.dir, 'setup-code');
    try { setupCode = (await fs.readFile(f, 'utf8')).trim(); }
    catch { setupCode = random().slice(0, 12); await fs.writeFile(f, setupCode, { mode: 0o600 }); }
  }
  const ai = options.ai || { transcribe, summarize };
  const accounts = createAccounts(store, { setupCode, issue, clock: options.accountClock });
  const presence = createPresence(store, { ...options.presence, allowed: accounts.allowed });
  const cleanupPresence = async force => {
    try { await presence.cleanupExpired(force); }
    catch { /* Cleanup is opportunistic; a temporary failure must not disable unrelated family/AI APIs. */ }
  };
  await cleanupPresence(true);
  const conversation = createConversation(store, { authenticate: session, adapter: options.conversation });
  const realtime = createRealtime(store, { ...options.realtime, authenticate: session });
  const contact = createFamilyContact(store, { allowed: accounts.allowed });
  const calls = createFamilyCall(store, { ...options.call, allowed: accounts.allowed });
  const actions = createActions(store, { authenticate: session,
    roster: async s => (await contact.handle('contactState', {}, s)).members,
    send: (data, token) => api('send', data, token, undefined, true),
    contactRequest: (data, s) => contact.handle('contactRequest', data, s),
    callCapabilities: s => calls.handle('callCapabilities', {}, s),
    callRequest: (data, s) => calls.handle('callStart', data, s) });
  const jobs = new Map(), urlCache = new Map(), rate = new Map();
  const errors = e => e.status ? e.message : (/(识别|语音|整理|AI|模型|没有|格式)/.test(e.message || '') ? e.message : '服务暂时不可用，请稍后重试');
  async function session(token) {
    if (!/^[a-f0-9]{48}$/.test(token || '')) fail('请先加入家庭', 401);
    const s = await store.get('s_' + hash(token));
    if (!s || s.revoked || s.expires < now()) fail('登录已过期，请重新使用邀请链接加入', 401);
    if (!await accounts.allowed(s)) fail('账号已被移除，请联系家庭创建者', 401);
    return s;
  }
  async function issue(room, role, name, account = {}) {
    const token = random(), doc = { _id: 's_' + hash(token), kind: 'session', room, role, name: text(name, 30) || (role === 'frame' ? '家里的相框' : '家人'),
      ...account, expires: now() + 7 * 86400000, lastSeen: now() };
    await store.put(doc, true); return { token, role, room, name: doc.name, ...(account.username ? { username: account.username } : {}) };
  }
  async function mediaFor(id, s) { const m = await store.get('f_' + id); if (!m || m.room !== s.room) fail('文件不存在', 404); return m; }
  async function mediaURL(id, s) {
    if (!id) return '';
    const f = await mediaFor(id, s);
    const cached = urlCache.get(id); if (cached && cached.until > now()) return cached.url;
    let url;
    if (store.url) url = await store.url(f.file);
    else { const access = random(); await store.put({ _id: 'd_' + hash(access), kind: 'download', room: s.room, file: f.file, mime: f.mime, expires: now() + 900000 }); url = '/media/' + access; }
    urlCache.set(id, { url, until: now() + 600000 }); return url;
  }
  async function hydrateMessages(messages, s, spatialState) {
    return Promise.all(messages.map(async m => ({ ...m, spatial: spatialState(m), imageURL: await mediaURL(m.image, s), audioURL: await mediaURL(m.audio, s) })));
  }
  async function api(action, data, token, signal, confirmedAction = false) {
    const startedAt = now();
    await cleanupPresence();
    // Sensor tokens have their own bounded, family-and-device-scoped authentication.
    if (action === 'presenceReport') {
      if (Buffer.byteLength(JSON.stringify({ action, data })) > PRESENCE_BODY_BYTES) fail('传感器请求过大', 413);
      return presence.report(data, token);
    }
    if (action === 'register') return accounts.register(data);
    if (action === 'login') return accounts.login(data);
    if (action === 'create') {
      if (!setupCode || !safeEqual(text(data.setupCode, 100), setupCode)) fail('开通码不正确', 403);
      const room = uid();
      await accounts.createRoom(room, text(data.name, 40) || '我们的家');
      return issue(room, 'owner', data.nickname || '我');
    }
    if (action === 'join') {
      if (!/^[a-f0-9]{48}$/.test(data.invite || '')) fail('邀请链接不完整');
      const inv = await store.get('i_' + hash(data.invite));
      if (!inv || inv.revoked || inv.expires < now()) fail('邀请已失效，请家人重新生成');
      return issue(inv.room, inv.role, data.nickname);
    }
    const s = await session(token);
    if (PRESENCE_ACTIONS.includes(action)) return presence.manage(action, data, s);
    if (['aiRealtimeCapabilities', 'aiRealtimeStart', 'aiRealtimeStatus', 'aiRealtimeStop'].includes(action)) return realtime.handle(action, data, s, token, signal);
    if (['aiCapabilities', 'aiChat', 'aiTranscribe'].includes(action)) return conversation.handle(action, data, s, token, signal);
    if (['contactState', 'contactRequest', 'contactRespond', 'contactEnd'].includes(action)) return contact.handle(action, data, s);
    if (['aiActionPrepare', 'aiActionGet', 'aiActionConfirm', 'aiActionCancel'].includes(action)) return actions.handle(action, data, s, token);
    if (['callCapabilities', 'callState', 'callStart', 'callCancelStart', 'callAccept', 'callReject', 'callEnd', 'callIce', 'callSignal'].includes(action)) return calls.handle(action, data, s);
    const family = () => { if (s.role === 'frame') fail('请在家人端操作', 403); };
    if (action === 'logout') {
      await store.mutate(s._id, current => current ? { ...current, revoked: true } : null);
      await realtime.endForSession(s);
      return { ok: true };
    }
    if (action === 'state') {
      const requestedHistory = historyIds(data.historyIds);
      if (now() - s.lastSeen > 15000) { await store.mutate(s._id, current => ({ ...current, lastSeen: now() })); }
      const [room, messages, members, people, receipts] = await Promise.all(['r_' + s.room].map(id => store.get(id)).concat([
        store.list('message', s.room), store.list('session', s.room), store.list('person', s.room), store.list('receipt', s.room)]));
      const { messages: visible, ...messagePage } = await messageHistory.page(messages, s.room, { limit: RECENT_LIMIT });
      const spatialState = await spatial.states(s.room);
      const accountCache = new Map();
      const membership = await Promise.all(members.filter(member => !member.revoked && member.expires > now())
        .map(async member => ({ member, allowed: await accounts.allowed(member, accountCache) })));
      const allowedMembers = membership.filter(item => item.allowed).map(item => item.member);
      const overview = await familyState.snapshot(allowedMembers, messages, spatialState, mediaURL, s);
      const items = await hydrateMessages(visible, s, spatialState);
      const recentIds = new Set(visible.map(message => message._id));
      const older = requestedHistory ? messages.filter(message => message.kind === 'message' && message.room === s.room && !message.deleted &&
        requestedHistory.has(message._id) && !recentIds.has(message._id)).sort(compareMessages) : [];
      return { room: { id: s.room, name: room.name }, role: s.role, name: s.name, ...(s.username ? { username: s.username } : {}), messages: items, messagePage, ...overview,
        ...await presence.snapshot(s),
        ...(requestedHistory ? { historyMessages: await hydrateMessages(older, s, spatialState) } : {}),
        members: allowedMembers.filter(m => !m.revoked && m.expires > now()).map(m => ({ id: m._id, name: m.name, role: m.role,
          ...(m.username ? { username: m.username } : {}), online: now() - m.lastSeen < 45000 })),
        people, receipts: receipts.map(r => ({ message: r.message, deliveredAt: r.deliveredAt, playedAt: r.playedAt })), serverTime: now() };
    }
    if (action === 'history') {
      const page = await messageHistory.page(await store.list('message', s.room), s.room, data);
      return { ...page, messages: await hydrateMessages(page.messages, s, await spatial.states(s.room)) };
    }
    if (action === 'framePresence') return familyState.update(data, s);
    if (action === 'invite') {
      family(); const invite = random(), role = data.role === 'frame' ? 'frame' : 'family';
      await store.put({ _id: 'i_' + hash(invite), kind: 'invite', room: s.room, role, expires: now() + 86400000 }, true);
      return { id: 'i_' + hash(invite), invite, role, expires: now() + 86400000 };
    }
    if (action === 'spatialImport') { family(); return spatial.start(data.id, s, startedAt); }
    if (action === 'spatialAsset') return spatial.asset(data.id, s);
    if (action === 'upload') {
      if (typeof data.base64 !== 'string' || data.base64.length > 4100000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) fail('文件过大或格式错误');
      const buffer = Buffer.from(data.base64, 'base64');
      if (!buffer.length || buffer.length > 3000000) fail('单个文件需小于 3 MB');
      let mime, ext;
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) { if (buffer.length < 20 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9 || !buffer.includes(Buffer.from([0xff, 0xda]))) fail('照片文件不完整'); mime = 'image/jpeg'; ext = 'jpg'; }
      else if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
        let offset = 8, imageData = false, ended = false;
        if (buffer.length < 57 || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR' || !buffer.readUInt32BE(16) || !buffer.readUInt32BE(20)) fail('照片文件不完整');
        while (offset + 12 <= buffer.length) {
          const size = buffer.readUInt32BE(offset), kind = buffer.toString('ascii', offset + 4, offset + 8);
          if (offset + size + 12 > buffer.length) fail('照片文件不完整');
          if (kind === 'IDAT' && size) imageData = true;
          offset += size + 12;
          if (kind === 'IEND') { ended = size === 0 && offset === buffer.length; break; }
        }
        if (!imageData || !ended) fail('照片文件不完整');
        mime = 'image/png'; ext = 'png';
      }
      else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
        if (buffer.length <= 44 || buffer.readUInt32LE(4) !== buffer.length - 8 || buffer.toString('ascii', 12, 16) !== 'fmt ' || buffer.readUInt32LE(16) !== 16 || buffer.readUInt32LE(28) !== 32000 || buffer.readUInt16LE(32) !== 2 || (buffer.length - 44) % 2 !== 0 || buffer.readUInt16LE(20) !== 1 || buffer.readUInt16LE(22) !== 1 || buffer.readUInt32LE(24) !== 16000 || buffer.readUInt16LE(34) !== 16 || buffer.toString('ascii', 36, 40) !== 'data' || buffer.readUInt32LE(40) !== buffer.length - 44 || buffer.length > 60 * 32000 + 44) fail('录音需为 60 秒以内的单声道 WAV');
        mime = 'audio/wav'; ext = 'wav';
      } else fail('支持 JPEG、PNG 图片和 WAV 录音');
      const id = hash(s.room + ':' + s._id + ':' + hash(buffer));
      const existing = await store.get('f_' + id);
      if (existing) return { id, mime: existing.mime, bytes: existing.bytes };
      if ((await store.list('file', s.room)).length >= 500) fail('本次 Demo 已达到 500 个文件上限');
      const file = await store.upload(uid() + '.' + ext, buffer);
      try { await store.put({ _id: 'f_' + id, id, kind: 'file', room: s.room, owner: s._id, file, mime, bytes: buffer.length, createdAt: now(), digest: hash(buffer) }, true); } catch (e) {
        const saved = await store.get('f_' + id);
        if (saved?.file !== file) await store.deleteFile(file);
        if (!saved) throw e;
      }
      return { id, mime, bytes: buffer.length };
    }
    if (action === 'send') {
      if (!validId(data.id)) fail('发送标识错误');
      const id = 'm_' + s.room + '_' + data.id;
      const old = await store.get(id); if (old) return { id, saved: true };
      if ((await store.list('message', s.room)).length >= 300) fail('本次 Demo 已达到 300 条消息上限');
      const image = text(data.image, 90), audio = text(data.audio, 90);
      if (image && !(await mediaFor(image, s)).mime.startsWith('image/')) fail('照片格式不正确');
      let duration = 0;
      if (audio) { const f = await mediaFor(audio, s); if (f.mime !== 'audio/wav') fail('录音格式不正确'); duration = Math.round((f.bytes - 44) / 32000); }
      let parent = null;
      if (data.parent) { parent = await store.get(data.parent); if (!parent || parent.room !== s.room || parent.type !== 'photo' || parent.deleted) fail('这张照片已不存在'); }
      if (s.role === 'frame' && !confirmedAction && (!audio || !parent)) fail('请对着当前照片录一段话');
      const body = text(data.text), link = text(data.link, 2000);
      if (link && !/^https:\/\/[^\s]+$/i.test(link)) fail('空间链接需要以 https:// 开头');
      if (!image && !audio && !body && !link) fail('先选择照片或写一句话');
      const m = { _id: id, kind: 'message', room: s.room, type: s.role === 'frame' && !confirmedAction ? 'reply' : 'photo',
        image: image || parent?.image || '', audio, text: body, link, parent: parent?._id || '', duration, name: s.name, author: s._id,
        createdAt: now(), updatedAt: now(), title: text(data.title, 80), transcription: '', aiStatus: audio ? 'waiting' : body ? 'ready-text' : 'none' };
      try { await store.put(m, true); } catch (e) { if (!await store.get(id)) throw e; }
      return { id, saved: true };
    }
    if (action === 'receipt') {
      if (s.role !== 'frame') fail('仅相框可确认送达', 403);
      const m = await store.get(data.id); if (!m || m.kind !== 'message' || m.room !== s.room) fail('消息不存在', 404);
      const id = 'a_' + m._id;
      await store.mutate(id, current => {
        const r = current || { _id: id, kind: 'receipt', room: s.room, message: m._id, deliveredAt: now() };
        if (data.played) r.playedAt = now();
        return r;
      }); return { ok: true };
    }
    if (action === 'edit') {
      family(); await store.mutate(typeof data.id === 'string' ? data.id : '', m => {
      if (!m || m.kind !== 'message' || m.room !== s.room || m.deleted) fail('记忆不存在', 404);
      const editedText = text(data.text, 6000), changed = editedText !== (m.editedText || '');
      const summary = text(data.summary, 1000);
      m.editedText = editedText; m.title = text(data.title, 80);
      if (summary || !m.card?.confirmed) m.card = { title: m.title, summary, people: Array.isArray(data.people) ? data.people.slice(0, 12).map(x => text(x, 40)).filter(Boolean) : [],
        year: text(data.year, 20), place: text(data.place, 100), confirmed: Boolean(summary), source: 'family' };
      if (changed && !m.card?.confirmed) { m.aiStatus = 'ready-text'; m.aiError = ''; }
      m.updatedAt = now(); return m; }); return { ok: true };
    }
    if (action === 'person') {
      family(); const name = text(data.name, 30); if (!name) fail('请填写人物称呼');
      const p = { _id: 'p_' + s.room + '_' + hash(name).slice(0, 24), kind: 'person', room: s.room, name, relation: text(data.relation, 40) };
      await store.put(p); return { ok: true };
    }
    if (action === 'remove') {
      family(); await store.mutate(typeof data.id === 'string' ? data.id : '', m => {
        if (!m || m.kind !== 'message' || m.room !== s.room) fail('记忆不存在', 404);
        return { ...m, deleted: true, updatedAt: now() };
      });
      await spatial.remove(data.id, s.room);
      return { ok: true };
    }
    if (action === 'revoke') {
      if (s.role !== 'owner') fail('仅创建者可移除设备', 403);
      const target = await store.get(data.id); if (!target || target.room !== s.room || target._id === s._id || !['session', 'invite'].includes(target.kind)) fail('设备不存在');
      await accounts.revoke(target, s);
      const revokedSessions = target.account ? (await store.list('session', s.room)).filter(member => member.account === target.account) : [target];
      for (const member of revokedSessions) if (member.kind === 'session') await realtime.endForSession(member);
      return { ok: true };
    }
    if (action === 'process') {
      const m = await store.get(data.id);
      if (!m || m.kind !== 'message' || m.room !== s.room || m.deleted || (s.role === 'frame' && m.author !== s._id)) fail('记忆不存在', 404);
      const resultState = current => ({ ok: true, state: current.aiStatus === 'done' ? 'already-done' : current.aiLeaseUntil > now() ? 'processing' : current.aiStatus, retryAfterMs: Math.max(0, (current.aiLeaseUntil || 0) - now()) });
      if (jobs.has(m._id)) return resultState(m);
      const lease = uid();
      const claimed = await store.mutate(m._id, current => {
        if (current.deleted || current.aiStatus === 'done' || current.aiLeaseUntil > now()) return null;
        return { ...current, aiStatus: 'processing', aiError: '', aiLease: lease, aiLeaseUntil: now() + 300000, updatedAt: now() };
      });
      if (!claimed) return resultState(await store.get(m._id));
      const update = change => store.mutate(m._id, current => {
        if (!current || current.aiLease !== lease) return null;
        return change(current);
      });
      const job = (async () => {
        try {
          if (claimed.audio && !claimed.transcription && !claimed.editedText) {
            const f = await mediaFor(claimed.audio, s);
            const transcription = await ai.transcribe(await store.read(f.file));
            await update(current => ({ ...current, transcription }));
          }
          const input = await store.get(m._id);
          if (input.deleted) return { ok: true };
          const original = input.editedText || input.transcription || input.text;
          if (!original) throw new Error('请先补充文字，再整理记忆');
          const card = await ai.summarize(original, store.app);
          await update(current => {
            const changed = (current.editedText || current.transcription || current.text) !== original;
            return { ...current, card: current.card?.confirmed || changed ? current.card : card,
              aiStatus: changed && !current.card?.confirmed ? 'ready-text' : 'done', aiError: '', aiLeaseUntil: 0, updatedAt: now() };
          });
        } catch (e) {
          await update(current => ({ ...current, aiStatus: 'failed', aiError: errors(e), aiLeaseUntil: 0, updatedAt: now() }));
        }
        const latest = await store.get(m._id);
        return { ...resultState(latest), state: latest.aiStatus };
      })();
      jobs.set(m._id, job); try { return await job; } finally { jobs.delete(m._id); }
    }

    fail('未知操作', 404);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    res.setHeader('Cache-Control', 'no-store');
    const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') return json({ ok: true, storage: env ? 'cloudbase' : 'local', version: '0.4.9', accounts: true,
        asrConfigured: Boolean(process.env.ASR_API_KEY || process.env.TENCENT_SECRET_ID || process.env.TENCENTCLOUD_SECRETID), aiConfigured: Boolean(process.env.AI_MODEL), maxRecordingSeconds: 60 });
      if (url.pathname === '/api' && req.method === 'POST') {
        const ip = req.socket.remoteAddress, bucket = Math.floor(now() / 60000), key = ip + ':' + bucket;
        rate.set(key, (rate.get(key) || 0) + 1); if (rate.get(key) > 600) fail('操作过于频繁，请稍后再试', 429);
        if (rate.size > 500) for (const k of rate.keys()) if (!k.endsWith(':' + bucket)) rate.delete(k);
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const bodyLimit = token.startsWith('ps1.') ? PRESENCE_BODY_BYTES : 4300000;
        if (Number(req.headers['content-length']) > bodyLimit) fail('文件超过大小限制', 413);
        let bytes = 0, chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > bodyLimit) fail('文件超过大小限制', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('请求格式错误'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || (body.data != null && (typeof body.data !== 'object' || Array.isArray(body.data)))) fail('请求格式错误');
        if (body.action === 'presenceReport') {
          if (bytes > PRESENCE_BODY_BYTES) fail('传感器请求过大', 413);
          if (Object.keys(body).some(key => !['action', 'data'].includes(key)) || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail('传感器请求格式错误');
        }
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnected);
        try { const result = await api(body.action, body.data || {}, token, controller.signal); if (!res.destroyed) return json(result); }
        finally { res.removeListener('close', disconnected); }
        return;
      }
      if (url.pathname.startsWith('/media/')) {
        const access = url.pathname.slice(7); if (!/^[a-f0-9]{48}$/.test(access)) fail('文件地址无效', 404);
        const record = await store.get('d_' + hash(access)); if (!record || record.expires < now()) fail('文件地址已过期，请刷新页面', 404);
        const buffer = await store.read(record.file);
        res.writeHead(200, { 'Content-Type': record.mime, 'Content-Length': buffer.length, 'Accept-Ranges': 'none', 'Cache-Control': 'private, max-age=300' }); return res.end(buffer);
      }
      if (url.pathname.startsWith('/spatial-media/')) {
        if (!['GET', 'HEAD'].includes(req.method)) fail('不支持的请求', 405);
        const entry = await spatial.access(url.pathname.slice('/spatial-media/'.length));
        res.setHeader('Accept-Ranges', 'bytes');
        let range;
        try { range = parseRange(req.headers.range, entry.bytes); }
        catch (error) { if (error.status === 416) res.setHeader('Content-Range', `bytes */${entry.bytes}`); throw error; }
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
        res.once('close', () => controller.abort());
        try {
          const source = req.method === 'HEAD' ? null : await spatial.read(entry, controller.signal, range);
          res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': range ? range.bytes : entry.bytes,
            ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${entry.bytes}` } : {}),
            'Content-Disposition': 'inline; filename="space.sog"', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
          if (!source) return res.end();
          await pipeline(source, res, { signal: controller.signal }); return;
        } finally { clearTimeout(timer); }
      }
      if (url.pathname === '/qr.svg') {
        const value = url.searchParams.get('text') || ''; if (value.length > 1800) fail('链接过长');
        const svg = await require('qrcode').toString(value, { type: 'svg', margin: 2, color: { dark: '#57537C', light: '#FFFFFF' } });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg);
      }
      if (!['GET', 'HEAD'].includes(req.method)) fail('不支持的请求', 405);
      const route = ['/', '/family', '/frame'].includes(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname);
      const filename = path.resolve(PUBLIC, '.' + route); if (!filename.startsWith(PUBLIC + path.sep)) fail('文件不存在', 404);
      let buffer; try { buffer = await fs.readFile(filename); } catch { fail('文件不存在', 404); }
      const realtimeConnect = realtime.enabled() ? ' https://*.rtc.qq.com wss://*.rtc.qq.com https://*.webrtc.qq.com wss://*.webrtc.qq.com https://yun.tim.qq.com https://web.sdk.qcloud.com' : '';
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self' blob:" + realtimeConnect + "; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.writeHead(200, { 'Content-Type': MIMES[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': route === '/index.html' ? 'no-store' : 'public, max-age=600' }); res.end(req.method === 'HEAD' ? undefined : buffer);
    } catch (e) { if (!res.headersSent) json({ error: errors(e) }, e.status || 503); else res.end(); }
  });
  server.once('close', () => presence.close());
  return { server, store, api };
}

if (require.main === module) createApp().then(({ server }) => {
  const port = Number(process.env.PORT || (process.env.MEMORY_CLOUDBASE_ENV ? 9000 : 8787));
  server.listen(port, process.env.MEMORY_CLOUDBASE_ENV ? '0.0.0.0' : (process.env.HOST || '127.0.0.1'), () => console.log('Memory Frame ready on port ' + port));
}).catch(e => { console.error('Startup failed:', e.message); process.exitCode = 1; });
module.exports = { createApp };
