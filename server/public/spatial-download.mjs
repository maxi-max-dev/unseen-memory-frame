const MAX_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Closed', 'AbortError');
}

function metadata(asset, baseURL) {
  if (asset?.format !== 'sog') throw new Error('模型格式暂不支持，请打开来源页面。');
  if (typeof asset.url !== 'string' || !asset.url) throw new Error('模型地址不可用，请关闭后重试。');
  const base = new URL(baseURL), url = new URL(asset.url, base);
  if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('模型地址不可用，请关闭后重试。');
  }
  const bytes = Number(asset.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) {
    throw new Error('空间文件大小超出支持范围，请打开来源页面。');
  }
  const digest = String(asset.digest || '').toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('空间文件缺少完整性信息，请重新导入。');
  const chunkBytes = asset.chunkBytes === undefined ? null : Number(asset.chunkBytes);
  if (chunkBytes !== null && (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES)) {
    throw new Error('空间传输信息无效，请关闭后重试。');
  }
  return { url, bytes, digest, chunkBytes };
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* A closed response needs no further cleanup. */ }
}

function validateResponse(response, start, end, total, ranged) {
  if (response.status !== (ranged ? 206 : 200)) throw new Error('空间文件暂时无法读取，请关闭后重试，或打开来源页面。');
  const contentRange = response.headers.get('content-range');
  if (ranged ? contentRange?.trim() !== `bytes ${start}-${end}/${total}` : contentRange !== null) {
    throw new Error('空间分段范围校验失败，请关闭后重试。');
  }
  const length = response.headers.get('content-length');
  if ((ranged && length === null) || (length !== null && (!/^\d+$/.test(length) || Number(length) !== end - start + 1))) {
    throw new Error('空间文件大小校验失败。');
  }
  if (!response.body?.getReader) throw new Error('空间文件未完整下载，请关闭后重试。');
}

/**
 * The browser viewer and HTTP acceptance use this same bounded download path.
 * Bytes from a chunk are never accepted as a complete model. The original
 * digest pins the entire download, including requests after signed-URL refresh.
 */
export async function downloadSpatialAsset(initialAsset, {
  baseURL, signal, refreshAsset, onProgress = () => {}
} = {}) {
  checkAbort(signal);
  const expected = metadata(initialAsset, baseURL);
  const ranged = expected.chunkBytes !== null && expected.bytes > expected.chunkBytes;
  const step = ranged ? expected.chunkBytes : expected.bytes;
  const buffer = new Uint8Array(expected.bytes);
  let asset = initialAsset, current = expected, refreshed = false;
  for (let start = 0; start < expected.bytes; start += step) {
    const end = Math.min(expected.bytes - 1, start + step - 1);
    let response;
    // Refresh at most once for the whole model, then resume this exact chunk.
    while (true) {
      checkAbort(signal);
      response = await fetch(current.url, {
        signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        ...(ranged ? { headers: { Range: `bytes=${start}-${end}` } } : {})
      });
      if (!EXPIRED_STATUSES.has(response.status) || refreshed || typeof refreshAsset !== 'function') break;
      await discard(response);checkAbort(signal);
      refreshed = true;onProgress({ received: start, total: expected.bytes, refreshing: true });
      asset = await refreshAsset();checkAbort(signal);
      current = metadata(asset, baseURL);
      if (current.bytes !== expected.bytes || current.digest !== expected.digest || current.chunkBytes !== expected.chunkBytes) {
        throw new Error('空间文件已变化，请关闭后重新打开，避免混合不同版本。');
      }
    }
    try { checkAbort(signal);validateResponse(response, start, end, expected.bytes, ranged); }
    catch (error) { await discard(response);throw error; }
    const reader = response.body.getReader();
    const abortReader = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abortReader, { once: true });
    let received = 0, complete = false;
    try {
      while (true) {
        checkAbort(signal);
        const { value, done } = await reader.read();checkAbort(signal);
        if (done) break;
        if (!value || received + value.byteLength > end - start + 1) throw new Error('空间文件大小校验失败。');
        buffer.set(value, start + received);received += value.byteLength;
        onProgress({ received: start + received, total: expected.bytes, refreshing: false });
      }
      if (received !== end - start + 1) throw new Error('空间文件未完整下载，请关闭后重试。');
      complete = true;
    } finally {
      signal?.removeEventListener('abort', abortReader);
      if (!complete) { try { await reader.cancel(); } catch {} }
      reader.releaseLock();
    }
  }
  checkAbort(signal);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), value => value.toString(16).padStart(2, '0')).join('');
  checkAbort(signal);
  if (digest !== expected.digest) throw new Error('空间文件完整性校验失败，请重新导入。');
  return { buffer: buffer.buffer, view: asset.view };
}
