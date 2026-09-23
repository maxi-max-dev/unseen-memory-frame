'use strict';
const { SpatialError } = require('./spatial-network');
// CloudBase HTTP functions cap response bodies at 6 MiB. Leave headroom for gateway encoding.
const CHUNK_BYTES = 4 * 1024 * 1024;
function checkedRange(range, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new SpatialError('模型文件大小无效', 500);
  if (!range) {
    if (bytes > CHUNK_BYTES) throw new SpatialError('模型需要分段读取，请刷新后重新打开空间', 413);
    return null;
  }
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= bytes || end - start + 1 > CHUNK_BYTES) {
    throw new SpatialError('模型读取范围无效或超过单次 4 MB 上限', 416);
  }
  return { start, end, bytes: end - start + 1 };
}
function parseRange(header, bytes) {
  if (header === undefined) return checkedRange(null, bytes);
  const match = typeof header === 'string' && /^bytes=(\d+)-(\d+)$/i.exec(header);
  if (!match) throw new SpatialError('模型仅支持单个完整的字节读取范围', 416);
  return checkedRange({ start: Number(match[1]), end: Number(match[2]) }, bytes);
}
module.exports = { CHUNK_BYTES, checkedRange, parseRange };
