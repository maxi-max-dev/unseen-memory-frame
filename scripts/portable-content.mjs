// Existing-family content snapshot and isolated LocalStore restore verification.
// Never logs credentials, sessions, response bodies, or temporary media URLs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { downloadSpatialAsset } from '../server/public/spatial-download.mjs';

const require = createRequire(import.meta.url);
const { LocalStore } = require('../server/store');
const { createApp } = require('../server/server');
const { shareURL } = require('../server/spatial-network');
const { validateSog } = require('../server/spatial-sog');
const scrypt = promisify(scryptCallback);
export const CLOUD_ORIGIN = 'https://example.invalid';
const CHUNK = 4 * 1024 * 1024;
const ALLOWED = new Set(['login', 'logout', 'state', 'history', 'spatialAsset']);
const MESSAGE_FIELDS = ['_id', 'kind', 'room', 'type', 'image', 'audio', 'text', 'link', 'parent', 'duration', 'name',
  'createdAt', 'updatedAt', 'title', 'transcription', 'editedText', 'aiStatus', 'aiError'];
const CARD_FIELDS = ['title', 'summary', 'people', 'year', 'place', 'confirmed', 'source'];
const digest = (data) => createHash('sha256').update(data).digest('hex');
const pick = (source, fields) => Object.fromEntries(fields.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
const writeJSON = (filename, data) => fs.writeFile(filename, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
let operationStage = 'arguments';
const stable = (value) => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function cleanMessage(message, room) {
  assert.ok(safeId(message?._id) && message.kind === 'message' && message.room === room && !message.deleted, 'Valid visible family message');
  const clean = pick(message, MESSAGE_FIELDS);
  if (message.card) clean.card = pick(message.card, CARD_FIELDS);
  // Old cloud session IDs are author metadata, never required for preview access.
  clean.author = 'portable-import';
  return clean;
}

export async function request(origin, action, data = {}, token, expected = 200) {
  assert.ok(ALLOWED.has(action), 'Read-only content action allowlist');
  const response = await fetch(origin + '/api', { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(70000) });
  if (response.status !== expected) { await response.body?.cancel(); throw Object.assign(new Error('HTTP operation failed'), { httpStatus: response.status }); }
  if (expected !== 200) { await response.body?.cancel(); return null; }
  return JSON.parse((await boundedBody(response, 8 * 1024 * 1024)).toString('utf8'));
}

async function boundedBody(response, maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Response exceeds bounded size');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readFamily(origin, token) {
  const state = await request(origin, 'state', {}, token);
  assert.ok(safeId(state.room?.id), 'Valid room');
  const found = new Map(); const cursors = new Set(); let cursor; let total;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await request(origin, 'history', { limit: 150, ...(cursor ? { cursor } : {}) }, token);
    assert.ok(Number.isSafeInteger(page.total) && page.total >= 0 && page.total <= 300, 'Bounded current family');
    total ??= page.total;
    assert.equal(page.total, total, 'Family changed while paging');
    for (const message of page.messages) {
      cleanMessage(message, state.room.id);
      assert.ok(!found.has(message._id), 'No duplicate history rows'); found.set(message._id, message);
    }
    if (!page.hasMore) break;
    assert.ok(typeof page.nextCursor === 'string' && !cursors.has(page.nextCursor), 'Page must progress');
    cursor = page.nextCursor; cursors.add(cursor);
  }
  assert.equal(found.size, total, 'Complete visible history');
  const messages = [...found.values()].sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id));
  const people = state.people.map((person) => {
    assert.ok(person.room === state.room.id && safeId(person._id), 'Scoped person');
    return pick(person, ['_id', 'kind', 'room', 'name', 'relation']);
  }).sort((a, b) => a._id.localeCompare(b._id));
  const receipts = state.receipts.filter((receipt) => found.has(receipt.message))
    .map((receipt) => pick(receipt, ['message', 'deliveredAt', 'playedAt'])).sort((a, b) => a.message.localeCompare(b.message));
  return { state, messages, snapshot: { schemaVersion: 1, room: state.room,
    messages: messages.map((message) => cleanMessage(message, state.room.id)), people, receipts } };
}

async function downloadMedia(urlText, origin, type) {
  const url = new URL(urlText, origin);
  assert.ok(!url.username && !url.password && !url.hash, 'Media URL shape');
  const local = new URL(origin).hostname === '127.0.0.1';
  assert.ok(local ? url.origin === origin : url.protocol === 'https:' &&
    (url.origin === CLOUD_ORIGIN || /\.(?:tcb\.qcloud\.la|myqcloud\.com|tencentcos\.cn)$/.test(url.hostname)), 'Returned cloud media host');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, 'Media status');
  const mime = (response.headers.get('content-type') || '').split(';')[0];
  assert.ok(type === 'image' ? ['image/jpeg', 'image/png'].includes(mime) : ['audio/wav', 'audio/x-wav', 'audio/wave'].includes(mime), 'Media MIME');
  const bytes = await boundedBody(response, 3000000);
  assert.ok(bytes.length > 0, 'Nonempty media');
  return { bytes, mime: type === 'audio' ? 'audio/wav' : mime };
}

async function downloadModel(origin, token, id) {
  const asset = await request(origin, 'spatialAsset', { id }, token);
  assert.equal(asset.chunkBytes, CHUNK, 'Preserve 4 MiB model protocol');
  assert.ok(new URL(asset.url, origin).pathname.startsWith('/spatial-media/'), 'Model must use permission checked application route');
  const parts = [];
  const originalFetch = globalThis.fetch;
  // Trace only this sequential download; never persist URL/token arguments.
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(url).origin, origin, 'No direct model storage URL');
    const response = await originalFetch(url, options);
    if (new URL(url).pathname.startsWith('/spatial-media/')) parts.push({ range: options.headers?.Range || null, status: response.status,
      contentRange: response.headers.get('content-range'), bytes: Number(response.headers.get('content-length')) });
    return response;
  };
  try {
    // No endpoint refresh needed for this bounded sequential transfer; each part
    // still checks the current account/session and the actual downloader checks
    // status, range, length, and whole-model digest.
    const result = await downloadSpatialAsset(asset, { baseURL: origin, signal: AbortSignal.timeout(180000) });
    return { bytes: Buffer.from(result.buffer), parts,
      metadata: pick(asset, ['format', 'sourceURL', 'sourceTitle', 'provider', 'bytes', 'digest', 'view']) };
  } finally { globalThis.fetch = originalFetch; }
}

export async function makeSeed(output, snapshot, media, models, memberNames = []) {
  const dataDir = path.join(output, 'seed-data');
  await fs.mkdir(path.join(dataDir, 'media'), { recursive: true });
  await fs.mkdir(path.join(output, 'private-access'));
  const room = snapshot.room.id, time = Date.now(), records = {};
  const put = (record) => { assert.ok(!Object.hasOwn(records, record._id), 'Unique record'); records[record._id] = record; };
  put({ _id: 'r_' + room, kind: 'room', room, name: snapshot.room.name, createdAt: Math.min(time, ...snapshot.messages.map((m) => m.createdAt)), historyCursorSecret: randomBytes(32).toString('hex') });
  put({ _id: 'account_room_registry', kind: 'roomRegistry', rooms: [room] });
  for (const message of snapshot.messages) put(message);
  for (const person of snapshot.people) put(person);
  for (const receipt of snapshot.receipts) put({ _id: 'a_' + receipt.message, kind: 'receipt', room, ...receipt });
  for (const item of media) {
    assert.ok(safeId(item.id) && /^[a-f0-9]{64}$/.test(item.sha256), 'Media identity');
    put({ _id: 'f_' + item.id, id: item.id, kind: 'file', room, owner: 'portable-import', file: item.file,
      mime: item.mime, bytes: item.bytes, digest: item.sha256, createdAt: time });
  }
  if (models.length) {
    const entries = {};
    for (const model of models) {
      const source = shareURL(model.sourceURL);
      assert.ok(!Object.hasOwn(entries, source.scene), 'Unique model scene');
      entries[source.scene] = { ...pick(model, ['format', 'sourceURL', 'sourceTitle', 'bytes', 'digest', 'view']),
        file: model.file, status: 'ready', stage: 'ready', progress: 100, error: '', leaseUntil: 0, pendingFile: '', updatedAt: time };
    }
    put({ _id: 'sp_' + room, kind: 'spatial', room, secret: randomBytes(32).toString('hex'), entries });
  }
  const accounts = [];
  for (let index = 0; index < 2; index++) {
    const role = index ? 'family' : 'owner', username = 'preview-' + role;
    const password = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('hex');
    const credentialDigest = (await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 })).toString('hex');
    const nickname = (memberNames[index] || (index ? '家人' : '我')) + '（本地预览）';
    put({ _id: 'u_' + digest(username), kind: 'account', status: 'active', username, name: nickname, room, role,
      mode: index ? 'join' : 'create', credential: { version: 1, salt, digest: credentialDigest }, createdAt: time, activatedAt: time });
    accounts.push({ username, password, nickname, role });
  }
  const accountFile = { schemaVersion: 1, scope: 'local-preview-only', room: snapshot.room, accounts };
  await writeJSON(path.join(dataDir, 'records.json'), records);
  await writeJSON(path.join(output, 'private-access/local-preview-accounts.json'), accountFile);
  await fs.writeFile(path.join(output, 'private-access/LOCAL-PREVIEW-LOGIN.txt'),
    'unseen 记忆相框｜仅本地预览账号\n只用于交付包的 127.0.0.1 服务，不可登录公网。\n' +
    accounts.map((a) => `\n${a.role === 'owner' ? '管理者' : '家人'}：${a.nickname}\n账号：${a.username}\n密码：${a.password}\n`).join('') +
    '\n这些是本次新生成的本地密码，不是原云账号密码。不要公开分享此文件。\n', { flag: 'wx', mode: 0o600 });
  return { recordCount: Object.keys(records).length };
}

export async function verifyRestore(output) {
  const resolved = path.resolve(output), snapshot = JSON.parse(await fs.readFile(path.join(resolved, 'snapshot.json'), 'utf8'));
  const accounts = JSON.parse(await fs.readFile(path.join(resolved, 'private-access/local-preview-accounts.json'), 'utf8'));
  const seed = path.join(resolved, 'seed-data'), before = digest(await fs.readFile(path.join(seed, 'records.json')));
  const verificationDir = await fs.mkdtemp(path.join(path.dirname(resolved), 'portable-verify-'));
  let app; const sessions = []; let origin;
  const report = { schemaVersion: 1, passed: false, evidence: 'Actual isolated local HTTP login/history/media/model restoration; no browser or GPU claim',
    accounts: 0, messages: 0, people: 0, receipts: 0, media: [], models: [], localSessionsRevoked: 0, seedUnchanged: false, localServerStopped: false };
  try {
    const isolatedData = path.join(verificationDir, 'data');
    await fs.cp(seed, isolatedData, { recursive: true, force: false, errorOnExist: true });
    const offlineProvider = { enabled: () => false, capabilities: () => ({ enabled: false }) };
    app = await createApp({ store: new LocalStore(isolatedData), setupCode: randomBytes(24).toString('hex'), realtime: { provider: offlineProvider } });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + app.server.address().port;
    for (const account of accounts.accounts) {
      const session = await request(origin, 'login', { username: account.username, password: account.password }); sessions.push(session);
      const family = await readFamily(origin, session.token);
      assert.equal(stable(family.snapshot), stable(pick(snapshot, ['schemaVersion', 'room', 'messages', 'people', 'receipts'])), 'Restored content and associations identical');
      report.accounts++;
      if (report.accounts === 1) {
        report.messages = family.messages.length; report.people = family.snapshot.people.length; report.receipts = family.snapshot.receipts.length;
        const mediaURLs = new Map();
        for (const message of family.messages) for (const type of ['image', 'audio']) if (message[type]) mediaURLs.set(message[type], message[type + 'URL']);
        for (const item of snapshot.media) {
          const result = await downloadMedia(mediaURLs.get(item.id), origin, item.type);
          assert.equal(digest(result.bytes), item.sha256, 'Restored media digest'); assert.equal(result.bytes.length, item.bytes, 'Restored media size');
          report.media.push({ type: item.type, bytes: item.bytes, sha256: item.sha256 });
        }
      }
      for (const model of snapshot.models) {
        const result = await downloadModel(origin, session.token, model.messageIds[0]);
        assert.equal(digest(result.bytes), model.digest, 'Restored complete model digest');
        report.models.push({ role: account.role, bytes: result.bytes.length, sha256: model.digest, parts: result.parts });
      }
    }
    for (const session of sessions) {
      await request(origin, 'logout', {}, session.token); await request(origin, 'state', {}, session.token, 401); report.localSessionsRevoked++;
    }
    report.passed = true;
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      report.localServerStopped = true;
    }
    // Only this newly created named sibling can be deleted. Never remove output
    // or a user-selected data directory, and never place verification in seed.
    assert.equal(path.dirname(verificationDir), path.dirname(resolved));
    assert.ok(path.basename(verificationDir).startsWith('portable-verify-') && verificationDir !== resolved);
    await fs.rm(verificationDir, { recursive: true, force: true });
    report.seedUnchanged = before === digest(await fs.readFile(path.join(seed, 'records.json')));
  }
  assert.ok(report.seedUnchanged && report.localServerStopped, 'Isolated restore cleanup');
  return report;
}

export async function exportContent({ credentialsFile, output }) {
  operationStage = 'input-validation';
  const resolved = path.resolve(output), source = JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const withinRepo = path.relative(repository, resolved);
  assert.ok(withinRepo.startsWith('..' + path.sep) || path.isAbsolute(withinRepo), 'Private output must be outside this repository');
  const credentials = source.credentials || source.accounts;
  assert.equal(credentials?.length, 2, 'Use existing two-account fixture');
  if (source.familyUrl) assert.equal(new URL(source.familyUrl).origin, CLOUD_ORIGIN, 'Fixed existing deployment');
  // Exclusive fresh output. Existing content is never overwritten or restored.
  await fs.mkdir(resolved);
  await fs.mkdir(path.join(resolved, 'seed-data/media'), { recursive: true });
  await fs.mkdir(path.join(resolved, 'verification'));
  const sessions = [], media = [], models = [];
  const summary = { schemaVersion: 1, createdAt: new Date().toISOString(), origin: CLOUD_ORIGIN,
    scope: 'All currently visible messages, people, visible-message receipts and referenced media in the existing shared family; not a database or deleted-record backup',
    newCloudFamilies: 0, cloudContentWrites: 0, cloudSessionsRevoked: 0, mediaBytes: 0, modelBytes: 0, passed: false };
  let snapshot;
  try {
    operationStage = 'cloud-login';
    for (const account of credentials) {
      const session = await request(CLOUD_ORIGIN, 'login', { username: account.username, password: account.password });
      sessions.push(session); assert.equal(session.room, sessions[0].room, 'Existing shared family');
    }
    operationStage = 'cloud-content-read';
    const first = await readFamily(CLOUD_ORIGIN, sessions[0].token);
    const second = await readFamily(CLOUD_ORIGIN, sessions[1].token);
    assert.equal(stable(first.snapshot), stable(second.snapshot), 'Both existing accounts see the same complete content');
    snapshot = first.snapshot;
    operationStage = 'cloud-media-download';
    const visited = new Set();
    for (const message of first.messages) for (const type of ['image', 'audio']) if (message[type] && !visited.has(message[type])) {
      const id = message[type]; assert.ok(safeId(id), 'Media ID'); visited.add(id);
      const downloaded = await downloadMedia(message[type + 'URL'], CLOUD_ORIGIN, type);
      const sha256 = digest(downloaded.bytes), extension = downloaded.mime === 'image/jpeg' ? 'jpg' : downloaded.mime === 'image/png' ? 'png' : 'wav';
      const file = sha256 + '.' + extension;
      try { await fs.writeFile(path.join(resolved, 'seed-data/media', file), downloaded.bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(digest(await fs.readFile(path.join(resolved, 'seed-data/media', file))), sha256); }
      media.push({ id, type, mime: downloaded.mime, bytes: downloaded.bytes.length, sha256, file });
    }
    operationStage = 'cloud-model-download';
    const scenes = new Map();
    for (const message of first.messages.filter((m) => m.spatial?.status === 'ready')) {
      const scene = shareURL(message.link).scene;
      if (scenes.has(scene)) { scenes.get(scene).messageIds.push(message._id); continue; }
      const downloaded = await downloadModel(CLOUD_ORIGIN, sessions[0].token, message._id);
      const file = downloaded.metadata.digest + '.sog';
      const target = path.join(resolved, 'seed-data/media', file);
      try { await fs.writeFile(target, downloaded.bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(digest(await fs.readFile(target)), downloaded.metadata.digest); }
      await validateSog(target, { signal: AbortSignal.timeout(30000) });
      const model = { ...downloaded.metadata, file, messageIds: [message._id], parts: downloaded.parts };
      models.push(model); scenes.set(scene, model);
    }
    operationStage = 'cloud-snapshot-consistency';
    const after = await readFamily(CLOUD_ORIGIN, sessions[0].token);
    assert.equal(stable(snapshot), stable(after.snapshot), 'Cloud content unchanged throughout export');
    snapshot = { ...snapshot, exportedAt: summary.createdAt, media, models,
      memberRoster: [...new Map(first.state.members.map((m) => [m.username || m.role + ':' + m.name, pick(m, ['name', 'role', 'username'])])).values()],
      limitations: ['No cloud auth/session/invite/download records', 'No deleted/unreferenced files or internal AI request state',
        'No historical live presence or active calls', 'Local AI/cloud credentials are not part of seed-data'] };
    await writeJSON(path.join(resolved, 'snapshot.json'), snapshot);
    operationStage = 'local-seed-build';
    const seedResult = await makeSeed(resolved, snapshot, media, models, sessions.map((s) => s.name));
    const uniqueMedia = [...new Map(media.map((m) => [m.file, m])).values()];
    Object.assign(summary, seedResult, { messages: snapshot.messages.length, people: snapshot.people.length, receipts: snapshot.receipts.length,
      referencedMedia: media.length, imageFiles: media.filter((m) => m.type === 'image').length, audioFiles: media.filter((m) => m.type === 'audio').length,
      uniqueMediaFiles: uniqueMedia.length, mediaBytes: uniqueMedia.reduce((n, m) => n + m.bytes, 0), modelFiles: models.length, modelBytes: models.reduce((n, m) => n + m.bytes, 0),
      cloudContentSha256: digest(stable(pick(snapshot, ['schemaVersion', 'room', 'messages', 'people', 'receipts']))),
      unavailableSpatialMessages: first.messages.filter((m) => m.link && m.spatial && m.spatial.status !== 'ready').length });
  } finally {
    let cleanupFailed = false;
    for (const session of sessions) {
      try { await request(CLOUD_ORIGIN, 'logout', {}, session.token); await request(CLOUD_ORIGIN, 'state', {}, session.token, 401); summary.cloudSessionsRevoked++; }
      catch { cleanupFailed = true; }
    }
    if (cleanupFailed) { operationStage = 'cloud-session-cleanup'; throw new Error('Cloud session cleanup failed'); }
  }
  operationStage = 'isolated-local-restore';
  const verification = await verifyRestore(resolved);
  await writeJSON(path.join(resolved, 'verification/RESTORE-VERIFICATION.json'), verification);
  summary.passed = verification.passed;
  summary.seedDataPath = 'seed-data'; summary.accountFile = 'private-access/local-preview-accounts.json';
  await writeJSON(path.join(resolved, 'content-summary.json'), summary);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, credentialsFile, output] = process.argv.slice(2);
    if (command === 'export' && credentialsFile && output) {
      const summary = await exportContent({ credentialsFile, output });
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    } else if (command === 'verify' && credentialsFile && !output) {
      operationStage = 'isolated-local-restore';
      process.stdout.write(JSON.stringify(await verifyRestore(credentialsFile), null, 2) + '\n');
    } else throw new Error('Usage');
  } catch (error) {
    // Failures intentionally do not echo exception messages, paths, auth data,
    // response bodies, or URLs. Partial output has no passed summary marker.
    process.stderr.write(JSON.stringify({ passed: false, stage: operationStage, error: 'Portable content operation failed; incomplete output must not be delivered',
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
