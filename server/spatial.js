'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SpatialError, shareURL, createNetwork, parsePage, parseCamera } = require('./spatial-network');
const { validateSog, LIMITS } = require('./spatial-sog');
const { CHUNK_BYTES } = require('./spatial-range');

const MAX_MODELS = 10, MAX_ROOM_BYTES = 256 * 1024 * 1024;
const fail = (message, status = 400) => { throw new SpatialError(message, status); };
const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function publicSpatial(entry, id, time = Date.now()) {
  if (!entry) return undefined;
  const expired = ['queued', 'importing'].includes(entry.status) && entry.leaseUntil <= time;
  return { id, status: expired ? 'failed' : entry.status, stage: expired ? 'expired' : entry.stage,
    progress: entry.progress, error: expired ? '上次空间导入已中断，请重试' : entry.error || '', sourceURL: entry.sourceURL,
    sourceTitle: entry.sourceTitle || '', provider: 'Insta360', bytes: entry.status === 'ready' ? entry.bytes : 0,
    digest: entry.status === 'ready' ? entry.digest : '', updatedAt: entry.updatedAt,
    ...(expired || entry.status === 'failed' ? { failureStage: expired ? entry.stage : entry.failureStage || '', errorCode: expired ? 'lease_expired' : entry.errorCode || '' } : {}) };
}
function createSpatial(store, options = {}) {
  const storage = store.forSpatial(), network = options.network || createNetwork(), clock = options.clock || Date.now;
  const limits = { ...LIMITS, ...options.limits }, maxModels = options.maxModels || MAX_MODELS, maxRoomBytes = options.maxRoomBytes || MAX_ROOM_BYTES;
  const budgetMs = options.budgetMs || 105000, leaseMs = options.leaseMs || 135000, accessMs = options.accessMs || 120000;
  const key = room => 'sp_' + room;
  async function message(id, session) {
    const m = await storage.get(typeof id === 'string' ? id : '');
    if (!m || m.kind !== 'message' || m.room !== session.room || m.deleted) fail('空间记忆不存在', 404);
    return m;
  }
  async function states(room) {
    const record = await storage.get(key(room));
    return m => {
      try { return publicSpatial(record?.entries?.[shareURL(m.link).scene], m._id, clock()); } catch { return undefined; }
    };
  }
  const deleteFile = file => storage.deleteSpatial ? storage.deleteSpatial(file) : storage.deleteFile(file);
  async function start(id, session, startedAt = clock()) {
    if (session.role === 'frame') fail('请在家人端操作', 403);
    const m = await message(id, session), source = shareURL(m.link), roomKey = key(session.room), lease = random();
    const deadline = startedAt + budgetMs;
    if (clock() >= deadline) fail('模型导入请求超时，请重试', 503);
    const claimed = await storage.mutate(roomKey, old => {
      const current = old || { _id: roomKey, kind: 'spatial', room: session.room, secret: random(), entries: {} };
      const entry = current.entries[source.scene];
      if (entry?.status === 'ready' || entry?.leaseUntil > clock()) return null;
      const others = Object.entries(current.entries).filter(([scene, e]) => scene !== source.scene && (e.status === 'ready' || e.leaseUntil > clock() || e.pendingFile));
      const reserved = others.reduce((sum, [, e]) => sum + (e.status === 'ready' ? e.bytes : limits.file), 0);
      if (others.length >= maxModels || reserved + limits.file > maxRoomBytes) fail('本家庭空间模型配额已满（最多 10 个、合计 256 MB）', 409);
      current.entries[source.scene] = { sourceURL: source.url, sourceTitle: entry?.sourceTitle || '', status: 'queued', stage: 'queued', progress: 0, error: '',
        lease, leaseUntil: clock() + leaseMs, updatedAt: clock(), pendingFile: entry?.pendingFile || '', attempts: (entry?.attempts || 0) + 1 };
      return current;
    }, { deadline });
    if (!claimed) return { spatial: publicSpatial((await storage.get(roomKey)).entries[source.scene], m._id, clock()) };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new SpatialError('空间导入超时，请重试')), Math.max(1, deadline - clock()));
    const signal = controller.signal;
    let directory, allocatedFile = '', committed = false;
    async function update(change) {
      signal.throwIfAborted();
      await message(m._id, session);
      const result = await storage.mutate(roomKey, current => {
        const entry = current?.entries[source.scene];
        if (signal.aborted || !entry || entry.lease !== lease || entry.leaseUntil <= clock()) return null;
        current.entries[source.scene] = { ...entry, ...change, updatedAt: clock() }; return current;
      }, { deadline });
      if (!result) throw new SpatialError('导入任务已被新的重试替代，请刷新查看');
      return result;
    }
    try {
      const previous = claimed.entries[source.scene].pendingFile;
      if (previous) { await deleteFile(previous); await update({ pendingFile: '' }); }
      await update({ status: 'importing', stage: 'resolving', progress: 5 });
      const parsed = parsePage(await network.page(source.url, signal), source.scene);
      await update({ sourceTitle: parsed.title, stage: 'downloading', progress: 15 });
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-spatial-'));
      const filename = path.join(directory, 'model.sog');
      const downloaded = await network.download(parsed.url, filename, limits.file, signal);
      signal.throwIfAborted();
      if (!Number.isSafeInteger(downloaded.bytes) || downloaded.bytes <= 0 || downloaded.bytes > limits.file || !/^[a-f0-9]{64}$/.test(downloaded.digest)) fail('模型下载不完整');
      await update({ stage: 'validating', progress: 65 });
      const validated = await validateSog(filename, { signal, limits });
      let view;
      if (parsed.cameraURL && network.camera) {
        // Optional initial viewpoint has its own short budget; malformed data falls back to viewer framing.
        const cameraSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        try { view = parseCamera(await network.camera(parsed.cameraURL, cameraSignal)); } catch { signal.throwIfAborted(); }
      }
      await update({ stage: 'storing', progress: 85 });
      const file = await storage.importSpatial(crypto.randomUUID() + '.sog', filename, { signal, allocated: async value => {
        allocatedFile = value; await update({ pendingFile: value });
      } });
      signal.throwIfAborted();
      await update({ status: 'ready', stage: 'ready', progress: 100, error: '', leaseUntil: 0, pendingFile: '', file,
        bytes: downloaded.bytes, digest: downloaded.digest, format: 'sog', model: validated, ...(view ? { view } : {}) });
      committed = true;
    } catch (e) {
      // Do not persist raw network/SDK errors: they can contain provider signed URLs.
      const error = signal.aborted ? '空间导入超时，请重试' : e instanceof SpatialError ? e.message : '空间导入失败，请稍后重试或打开来源链接';
      let cleanupFailed = false;
      if (allocatedFile) { try { await deleteFile(allocatedFile); } catch { cleanupFailed = true; } }
      await storage.mutate(roomKey, current => {
        const entry = current?.entries[source.scene]; if (!entry || entry.lease !== lease) return null;
        current.entries[source.scene] = { ...entry, status: 'failed', stage: 'failed', failureStage: entry.stage,
          errorCode: signal.aborted ? 'import_timeout' : e instanceof SpatialError ? e.code || 'import_failed' : 'import_failed', progress: 0, error,
          leaseUntil: 0, updatedAt: clock(), pendingFile: cleanupFailed ? allocatedFile : (allocatedFile ? '' : entry.pendingFile),
          ...(e instanceof SpatialError && e.storageDiagnostic?.event === 'spatial-storage-dns-rejected' ? { storageDiagnostic: e.storageDiagnostic } : {}) };
        return current;
      }, { deadline: startedAt + 130000 });
    } finally {
      clearTimeout(timer);
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      // Failure after a commit is never silently reported as ready by an older worker.
      if (!committed && !signal.aborted) controller.abort();
    }
    const latest = (await storage.get(roomKey))?.entries[source.scene];
    return { spatial: publicSpatial(latest, m._id, clock()) };
  }
  async function asset(id, session) {
    const m = await message(id, session), source = shareURL(m.link), record = await storage.get(key(session.room)), entry = record?.entries[source.scene];
    if (!entry || entry.status !== 'ready') fail('空间尚未准备好，请稍后再试', 409);
    const payload = Buffer.from(JSON.stringify({ r: session.room, m: m._id, s: session._id, e: clock() + accessMs, d: entry.digest })).toString('base64url');
    return { url: '/spatial-media/' + payload + '.' + hmac(record.secret, payload), bytes: entry.bytes, digest: entry.digest, chunkBytes: CHUNK_BYTES,
      format: 'sog', sourceURL: entry.sourceURL, sourceTitle: entry.sourceTitle, provider: 'Insta360', ...(entry.view ? { view: entry.view } : {}) };
  }
  async function access(token) {
    if (typeof token !== 'string' || token.length > 1600 || !/^[\w-]+\.[a-f0-9]{64}$/.test(token)) fail('模型地址无效或已过期', 404);
    const [payload, signature] = token.split('.'); let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { fail('模型地址无效或已过期', 404); }
    if (!/^[a-zA-Z0-9_-]{1,90}$/.test(data?.r || '') || !/^s_[a-f0-9]{64}$/.test(data?.s || '') || !Number.isSafeInteger(data.e) || data.e <= clock()) fail('模型地址无效或已过期', 404);
    const record = await storage.get(key(data.r));
    if (!record || !equal(hmac(record.secret, payload), signature)) fail('模型地址无效或已过期', 404);
    const session = await storage.get(data.s);
    if (!session || session.room !== data.r || session.revoked || session.expires <= clock()) fail('模型地址无效或已过期', 404);
    if (session.account) {
      const account = await storage.get(session.account);
      if (!account || account.kind !== 'account' || account.revoked || account.status !== 'active' || account.room !== session.room || account.role !== session.role) fail('模型地址无效或已过期', 404);
    }
    const m = await message(data.m, session), source = shareURL(m.link), entry = record.entries[source.scene];
    if (!entry || entry.status !== 'ready' || entry.digest !== data.d) fail('模型地址无效或已过期', 404);
    return entry;
  }
  async function remove(id, room) {
    const m = await storage.get(id); let source;
    try { source = shareURL(m.link); } catch { return; }
    const otherMessages = await storage.list('message', room);
    if (otherMessages.some(other => { try { return !other.deleted && other._id !== id && shareURL(other.link).scene === source.scene; } catch { return false; } })) return;
    const cleanup = random();
    const cancelled = await storage.mutate(key(room), current => {
      const entry = current?.entries[source.scene]; if (!entry) return null;
      // Message removal is a soft delete. Completed private models remain reusable
      // by another message in this family and continue to consume the same quota.
      if (entry.status === 'ready') return null;
      current.entries[source.scene] = { ...entry, status: 'failed', stage: 'removed', error: '空间记忆已删除', lease: '', leaseUntil: 0, cleanup, file: '', pendingFile: entry.file || entry.pendingFile || '', updatedAt: clock() };
      return current;
    }, { deadline: clock() + 10000 });
    // Only a successful cancellation grants permission to delete. CAS callbacks
    // can be retried after another worker commits ready, so they have no effects.
    if (!cancelled) return;
    const pendingFile = cancelled.entries[source.scene].pendingFile;
    if (pendingFile) await deleteFile(pendingFile);
    await storage.mutate(key(room), current => {
      const entry = current?.entries[source.scene]; if (!entry || entry.stage !== 'removed' || entry.cleanup !== cleanup || entry.pendingFile !== pendingFile) return null;
      current.entries[source.scene] = { ...entry, pendingFile: '' }; return current;
    }, { deadline: clock() + 10000 });
  }
  return { start, asset, states, access, remove, read: (entry, signal, range) => storage.readSpatial(entry.file, entry.bytes, { signal, range }) };
}
module.exports = { createSpatial, publicSpatial };
