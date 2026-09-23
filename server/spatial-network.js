'use strict';
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const fs = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');

const SHARE_HOST = 'app.insta360.com';
const ASSET_HOSTS = new Set(['insta360-app-hz.oss-cn-hangzhou.aliyuncs.com']);
class SpatialError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const reject = message => { throw new SpatialError(message); };
function checkedURL(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\s\\]/.test(input)) reject('空间链接格式不正确');
  let url; try { url = new URL(input); } catch { reject('空间链接格式不正确'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) reject('空间链接必须使用安全的 HTTPS 地址');
  return url;
}
function shareURL(input) {
  const url = checkedURL(input);
  const match = /^\/3dspace\/detail\/(GS3DC[0-9a-fA-F]{32})\/?$/.exec(url.pathname);
  if (url.hostname !== SHARE_HOST || !match) reject('目前仅支持影石 3D 空间分享链接');
  return { url: `https://${SHARE_HOST}/3dspace/detail/${match[1]}`, scene: match[1] };
}
function assetURL(input, extension = 'sog') {
  const url = checkedURL(input);
  if (!['sog', 'json'].includes(extension) || !ASSET_HOSTS.has(url.hostname) || !url.pathname.toLowerCase().endsWith('.' + extension)) reject('影石模型资源地址不受支持');
  return url;
}
const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip, bits, 'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::',23], ['2001:db8::',32], ['2002::',16], ['3fff::',20]]) blocked.addSubnet(ip, bits, 'ipv6');
function publicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
async function resolvePublic(hostname, lookup = dns.lookup, signal) {
  signal?.throwIfAborted();
  let timer, abort;
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new SpatialError('模型地址解析超时，请重试')), 8000);
    abort = () => rejectPromise(signal.reason); signal?.addEventListener('abort', abort, { once: true });
  });
  let addresses;
  try { addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(x => !publicAddress(x.address))) reject('模型资源地址未通过安全检查');
  return addresses.find(x => x.family === 4) || addresses[0];
}
function pinnedLookup(selected) {
  return (_hostname, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family);
}
function requestResponse(url, { signal, selected, method = 'GET', headers = {}, request = https.request }) {
  return new Promise((resolve, rejectPromise) => {
    const req = request(url, { method, signal, agent: false, lookup: pinnedLookup(selected), family: selected.family,
      headers: { 'User-Agent': 'MemoryFrame/0.1', 'Accept-Encoding': 'identity', ...headers } }, resolve);
    req.on('error', rejectPromise);
    req.setTimeout(15000, () => req.destroy(new SpatialError('模型下载超时，请重试')));
    req.end();
  });
}
function createNetwork({ lookup, request } = {}) {
  async function open(input, kind, signal) {
    let url = input;
    for (let hop = 0; hop <= 3; hop++) {
      const parsed = kind === 'share' ? new URL(shareURL(url).url) : assetURL(url, kind === 'camera' ? 'json' : 'sog');
      // Validate every hop and pin the checked DNS result to this TLS connection.
      const selected = await resolvePublic(parsed.hostname, lookup, signal);
      const response = await requestResponse(parsed, { signal, selected, request });
      if ([301,302,303,307,308].includes(response.statusCode)) {
        const location = response.headers.location; response.destroy();
        if (!location || hop === 3) reject('模型地址跳转过多或无效');
        url = new URL(location, parsed).href; continue;
      }
      if (response.statusCode !== 200) { response.destroy(); reject('影石分享不可用或模型下载失败，请检查来源链接'); }
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding !== 'identity') { response.destroy(); reject('模型下载压缩方式不受支持'); }
      return response;
    }
  }
  async function transfer(input, kind, limit, signal, destination) {
    const response = await open(input, kind, signal);
    const length = response.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(String(length)) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
      response.destroy(); reject('模型文件超过大小限制');
    }
    let bytes = 0; const digest = crypto.createHash('sha256'), chunks = [];
    const measure = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) return done(new SpatialError('模型文件超过大小限制'));
      digest.update(chunk); done(null, chunk);
    }});
    try {
      if (destination) await pipeline(response, measure, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
      else { await pipeline(response, measure, async function* (source) { for await (const chunk of source) { chunks.push(chunk); } }, { signal }); }
    } catch (e) { response.destroy(); throw e; }
    if (!bytes || (length !== undefined && bytes !== Number(length))) reject('模型下载不完整，请重试');
    return { bytes, digest: digest.digest('hex'), ...(destination ? {} : { buffer: Buffer.concat(chunks) }) };
  }
  return {
    page: async (url, signal) => (await transfer(url, 'share', 2 * 1024 * 1024, signal)).buffer.toString('utf8'),
    camera: async (url, signal) => (await transfer(url, 'camera', 1024 * 1024, signal)).buffer.toString('utf8'),
    download: (url, destination, limit, signal) => transfer(url, 'asset', limit, signal, destination)
  };
}
function parsePage(html, scene) {
  const match = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  let detail; try { detail = JSON.parse(match?.[1]).props.pageProps.taskDetail; } catch { reject('影石分享页面已变化或不可用，请打开来源链接'); }
  if (!detail || detail.taskOrderNo !== scene || detail.isPrivate !== 0 || !Array.isArray(detail.outputs)) reject('影石分享不可用或场景信息不匹配');
  const models = detail.outputs.filter(x => x?.type === 'model' && x.fileFormat === 'sog');
  if (models.length !== 1) reject('分享中没有可用的 SOG 空间模型');
  const url = assetURL(models[0].url).href;
  const title = typeof detail.title === 'string' ? detail.title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : 'Insta360 空间';
  const cameras = detail.outputs.filter(x => x?.type === 'model' && x.fileFormat === 'json');
  let cameraURL;
  if (cameras.length === 1) { try { cameraURL = assetURL(cameras[0].url, 'json').href; } catch { /* Optional camera data never broadens the resource allowlist. */ } }
  return { url, title, cameraURL };
}
function parseCamera(input) {
  let cameras; try { cameras = JSON.parse(input); } catch { return undefined; }
  if (!Array.isArray(cameras) || cameras.length > 5000) return undefined;
  const candidates = [...cameras.filter(x => /_cam1_up$/.test(x?.img_name)), ...cameras.filter(x => /_cam1_center$/.test(x?.img_name)), ...cameras];
  for (const camera of candidates) {
  const vector = (value, limit) => Array.isArray(value) && value.length === 3 && value.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= limit);
  if (!camera || !vector(camera.position, 100000) || !Array.isArray(camera.rotation) || camera.rotation.length !== 3 || !camera.rotation.every(row => vector(row, 1.001))) continue;
  if (![camera.width, camera.height].every(x => Number.isInteger(x) && x > 0 && x <= 8192) || ![camera.fx, camera.fy].every(x => Number.isFinite(x) && x >= 1 && x <= 20000)) continue;
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0), r = camera.rotation;
  if (r.some((a, i) => r.some((b, j) => Math.abs(dot(a, b) - Number(i === j)) > 0.01))) continue;
  const fov = 2 * Math.atan(camera.height / (2 * camera.fy)) * 180 / Math.PI;
  if (fov < 20 || fov > 140) continue;
  return { position: camera.position, forward: r.map(row => row[2]), up: r.map(row => -row[1]), fov: Math.max(35, Math.min(75, fov)) };
  }
  return undefined;
}
module.exports = { SpatialError, shareURL, assetURL, publicAddress, resolvePublic, pinnedLookup, createNetwork, parsePage, parseCamera };
