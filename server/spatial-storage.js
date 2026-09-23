'use strict';
const https = require('node:https');
const fs = require('node:fs');
const dns = require('node:dns/promises');
const net = require('node:net');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { SpatialError, resolvePublic, publicAddress, pinnedLookup } = require('./spatial-network');
const { checkedRange } = require('./spatial-range');

const SDK_OPTIONS = { timeout: 5000, retryOptions: { retries: 0 } };
// URLs here originate in authenticated CloudBase responses, never in API input.
// They are used only in memory and never returned to the viewer.
function cloudURL(input) {
  let url; try { url = new URL(input); } catch { throw new SpatialError('云模型存储地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new SpatialError('云模型存储需要 HTTPS 地址');
  return url;
}
function addressCategory(address) {
  if (publicAddress(address)) return 'public';
  if (net.isIP(address) !== 4) return net.isIP(address) === 6 ? 'nonpublic-ipv6' : 'invalid';
  const [first, second] = address.split('.').map(Number);
  if (first === 10) return 'private-10';
  if (first === 172 && second >= 16 && second <= 31) return 'private-172';
  if (first === 192 && second === 168) return 'private-192';
  if (first === 100 && second >= 64 && second <= 127) return 'shared-100';
  if (first === 127) return 'loopback';
  if (first === 169 && second === 254) return 'link-local';
  return 'other-nonpublic';
}
function ownCosBucket(url, file, environment, cloudPath) {
  if (typeof environment !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(environment) || typeof file !== 'string') return false;
  const prefix = `cloud://${environment}.`;
  if (!file.startsWith(prefix)) return false;
  const value = file.slice(prefix.length), slash = value.indexOf('/');
  const bucket = value.slice(0, slash), object = value.slice(slash + 1);
  if (slash < 1 || !/^[a-z0-9][a-z0-9-]{1,62}-[0-9]{5,20}$/.test(bucket) || !/^memory-demo\/spatial\/[a-zA-Z0-9-]+\.sog$/.test(object)
    || (cloudPath && object !== cloudPath) || url.pathname !== '/' + object) return false;
  const hostPrefix = bucket + '.cos.', hostSuffix = '.myqcloud.com';
  return url.hostname.startsWith(hostPrefix) && url.hostname.endsWith(hostSuffix)
    && /^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.hostname.slice(hostPrefix.length, -hostSuffix.length));
}
async function resolveBucket(hostname, lookup, signal) {
  signal?.throwIfAborted();
  let timer, abort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SpatialError('模型地址解析超时，请重试')), 8000);
    abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true });
  });
  let addresses;
  try { addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  // Tencent documents same-region COS DNS routing via 169.254.0.x. This exception
  // exists only after matching the authenticated SDK file to our exact environment/bucket.
  // It is not available to provider/user links. Tencent's metadata IP remains blocked.
  const cosRoute = address => /^169\.254\.0\./.test(address) && Number(address.split('.')[3]) > 0
    && Number(address.split('.')[3]) < 255 && address !== '169.254.0.23';
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => net.isIP(entry.address) !== entry.family
    || (!publicAddress(entry.address) && !(entry.family === 4 && cosRoute(entry.address))))) throw new SpatialError('模型资源地址未通过安全检查');
  const selected = addresses.find(entry => entry.family === 4) || addresses[0];
  return { address: selected.address, family: selected.family };
}
async function resolveStorage(url, lookup, signal, operation, diagnostic = item => console.warn(JSON.stringify(item)), ownBucket = false) {
  let summary;
  try {
    return await (ownBucket ? resolveBucket : resolvePublic)(url.hostname, async (hostname, options) => {
      const addresses = await (lookup || dns.lookup)(hostname, options);
      if (Array.isArray(addresses)) {
        const counts = new Map();
        for (const entry of addresses) {
          const key = `${entry.family === 4 ? 4 : entry.family === 6 ? 6 : 'invalid'}:${addressCategory(entry.address)}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        summary = [...counts].map(([key, count]) => { const [family, category] = key.split(':'); return { family, category, count }; });
      }
      return addresses;
    }, signal);
  } catch (error) {
    if (error instanceof SpatialError && (error.code === 'unsafe_dns' || error.message === '模型资源地址未通过安全检查')) {
      // Only the authenticated SDK endpoint hostname and aggregate categories are logged.
      // Never include addresses, URL paths/queries, cloud file IDs or raw SDK errors.
      const safeDiagnostic = { event: 'spatial-storage-dns-rejected', operation,
        hostname: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? '[literal-ip]' : url.hostname,
        answers: summary || [] };
      // Kept only in the private import record when platform log delivery is unavailable.
      error.storageDiagnostic = safeDiagnostic;
      diagnostic(safeDiagnostic);
    }
    throw error;
  }
}
async function uploadCloud(app, key, filename, { signal, allocated, request = https.request, lookup, diagnostic, environment } = {}) {
  signal?.throwIfAborted();
  const cloudPath = 'memory-demo/spatial/' + key;
  const metadata = await app.getUploadMetadata({ cloudPath }, SDK_OPTIONS);
  signal?.throwIfAborted();
  const d = metadata?.data;
  if (metadata?.code || !d?.fileId || !d?.authorization || !d?.token || !d?.cosFileId) throw new SpatialError('云模型存储初始化失败');
  const url = cloudURL(d.url), selected = await resolveStorage(url, lookup, signal, 'upload', diagnostic, ownCosBucket(url, d.fileId, environment, cloudPath));
  await allocated(d.fileId);
  signal?.throwIfAborted();
  const bytes = (await fs.promises.stat(filename)).size;
  const source = fs.createReadStream(filename);
  let req;
  const responseJob = new Promise((resolve, reject) => {
    req = request(url, { method: 'PUT', signal, agent: false, lookup: pinnedLookup(selected), family: selected.family,
      headers: { Signature: d.authorization, authorization: d.authorization, 'x-cos-security-token': d.token,
        'x-cos-meta-fileid': d.cosFileId, key: encodeURIComponent(cloudPath), 'Content-Length': bytes, 'Content-Type': 'application/octet-stream' } }, async response => {
      try {
        let length = 0;
        for await (const chunk of response) { length += chunk.length; if (length > 32768) throw new Error('response size'); }
        // A successful COS PUT has an empty response; XML errors (even HTTP 200) fail closed.
        if (response.statusCode < 200 || response.statusCode >= 300 || length) throw new SpatialError('云模型写入失败，请重试');
        resolve();
      } catch (e) { response.destroy(); reject(e); }
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new SpatialError('云模型写入超时，请重试')));
  });
  const uploadJob = pipeline(source, req, { signal });
  try { await Promise.all([responseJob, uploadJob]); return d.fileId; }
  finally { req.destroy(); source.destroy(); await Promise.allSettled([responseJob, uploadJob]); }
}
async function readCloud(app, file, bytes, { signal, request = https.request, lookup, diagnostic, environment, range } = {}) {
  const part = checkedRange(range, bytes), expected = part ? part.bytes : bytes;
  const result = await app.getTempFileURL({ fileList: [{ fileID: file, maxAge: 120, urlType: 'COS_URL' }] }, SDK_OPTIONS);
  const item = result.fileList?.[0];
  if (!item?.tempFileURL || (item.code && item.code !== 'SUCCESS')) throw new SpatialError('云模型读取失败');
  signal?.throwIfAborted();
  const url = cloudURL(item.tempFileURL), selected = await resolveStorage(url, lookup, signal, 'read', diagnostic, ownCosBucket(url, file, environment));
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', signal, agent: false, lookup: pinnedLookup(selected), family: selected.family,
      headers: { 'Accept-Encoding': 'identity', ...(part ? { Range: `bytes=${part.start}-${part.end}` } : {}) } }, response => {
      const contentRange = part ? `bytes ${part.start}-${part.end}/${bytes}` : undefined;
      if (response.statusCode !== (part ? 206 : 200) || response.headers['content-range'] !== contentRange
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
        || (part && response.headers['content-length'] === undefined)
        || (response.headers['content-length'] !== undefined && String(expected) !== response.headers['content-length'])) {
        response.destroy(); reject(new SpatialError('云模型读取失败')); return;
      }
      let length = 0;
      const stream = new Transform({ transform(chunk, _encoding, done) {
        length += chunk.length; done(length > expected ? new SpatialError('模型文件大小不匹配') : null, chunk);
      }, flush(done) { done(length === expected ? null : new SpatialError('模型文件不完整')); } });
      // A remote response can fail before the awaiting caller attaches pipeline().
      // Retain the stream's error state for that consumer without an unhandled event.
      stream.on('error', () => {});
      // Destruction on client close propagates through the upstream response.
      stream.on('close', () => { response.destroy(); req.destroy(); });
      response.on('error', e => stream.destroy(e)); response.pipe(stream); resolve(stream);
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new SpatialError('云模型读取超时'))); req.end();
  });
}
module.exports = { uploadCloud, readCloud, SDK_OPTIONS, cloudURL };
