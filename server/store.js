'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const streams = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { uploadCloud, readCloud, SDK_OPTIONS } = require('./spatial-storage');
const { checkedRange } = require('./spatial-range');

class LocalStore {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'records.json'); this.queue = Promise.resolve(); }
  async init() {
    await fs.mkdir(path.join(this.dir, 'media'), { recursive: true });
    try { this.records = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.records = {}; }
  }
  async get(id) { return typeof id === 'string' ? structuredClone(this.records[id] || null) : null; }
  async list(kind, room) { return Object.values(this.records).filter(x => x.kind === kind && (!room || x.room === room)).map(x => structuredClone(x)); }
  async mutate(id, change) {
    const job = this.queue.then(async () => {
      const doc = change(structuredClone(this.records[id] || null));
      if (!doc) return null;
      const records = { ...this.records, [id]: structuredClone(doc) };
      const tmp = this.file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(records), { mode: 0o600 });
      await fs.rename(tmp, this.file);
      this.records = records;
      return structuredClone(doc);
    });
    this.queue = job.catch(() => {}); return job;
  }
  async put(doc, create = false) {
    return this.mutate(doc._id, old => {
      if (create && old) { const e = new Error('duplicate'); e.code = 'DUPLICATE'; throw e; }
      return doc;
    });
  }
  async deleteFile(file) { await fs.rm(path.join(this.dir, 'media', file), { force: true }); }
  async upload(key, data) { await fs.writeFile(path.join(this.dir, 'media', key), data, { flag: 'wx', mode: 0o600 }); return key; }
  async read(file) { return fs.readFile(path.join(this.dir, 'media', file)); }
  forSpatial() { return this; }
  async importSpatial(key, filename, { signal, allocated }) {
    await allocated(key); signal.throwIfAborted();
    await pipeline(streams.createReadStream(filename), streams.createWriteStream(path.join(this.dir, 'media', key), { flags: 'wx', mode: 0o600 }), { signal });
    return key;
  }
  async readSpatial(file, bytes, { signal, range }) {
    const part = checkedRange(range, bytes);
    return streams.createReadStream(path.join(this.dir, 'media', file), { signal, start: part ? part.start : 0, end: part ? part.end : bytes - 1 });
  }
}

const checked = result => {
  if (result.code) throw new Error('CloudBase: ' + result.code);
  return result;
};

class CloudStore {
  constructor(env, options = {}) {
    const tcb = require('@cloudbase/node-sdk');
    this.env = env;
    this.app = tcb.init({ env, timeout: options.timeout || 65000 });
    this.db = this.app.database(options.timeout ? { timeout: options.timeout, retryOptions: { retries: 0 } } : {});
    this.collection = this.db.collection('memory_demo_records');
  }
  async init() { /* The deployment script creates the collection with client access denied. */ }
  async get(id) {
    if (typeof id !== 'string') return null;
    const { data } = checked(await this.collection.where({ _id: id }).limit(1).get());
    return data[0] || null;
  }
  async list(kind, room) {
    const where = { kind }; if (room) where.room = room;
    const out = [];
    for (let skip = 0; skip < 1000; skip += 100) {
      const { data } = checked(await this.collection.where(where).skip(skip).limit(100).get());
      out.push(...data); if (data.length < 100) break;
    }
    return out;
  }
  async put(doc, create = false) {
    if (create) { checked(await this.collection.add(doc)); }
    else { const { _id, ...data } = doc; checked(await this.collection.doc(_id).set(data)); }
    return doc;
  }
  async mutate(id, change, options = {}) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (options.deadline && Date.now() >= options.deadline) throw new Error('Spatial storage deadline');
      const old = await this.get(id);
      const next = change(old && structuredClone(old));
      if (!next) return null;
      const { _id, ...data } = next;
      data._rev = (old?._rev || 0) + 1;
      if (!old) {
        try { checked(await this.collection.add({ _id: id, ...data })); return { _id: id, ...data }; }
        catch (e) { if (!await this.get(id)) throw e; }
      } else {
        const result = checked(await this.collection.where({ _id: id,
          _rev: old._rev === undefined ? this.db.command.exists(false) : old._rev }).update(data));
        if (result.updated === 1) return { _id: id, ...data };
      }
    }
    throw new Error('Concurrent update retry exhausted');
  }
  async deleteFile(file) { await this.app.deleteFile({ fileList: [file] }); }
  async upload(key, data) {
    const res = await this.app.uploadFile({ cloudPath: 'memory-demo/' + key, fileContent: data });
    if (!res.fileID) throw new Error('云存储写入失败');
    return res.fileID;
  }
  async read(file) { const r = await this.app.downloadFile({ fileID: file }); return Buffer.from(r.fileContent); }
  async url(file) {
    const r = await this.app.getTempFileURL({ fileList: [{ fileID: file, maxAge: 900 }] });
    const item = r.fileList?.[0];
    if (!item?.tempFileURL || (item.code && item.code !== 'SUCCESS')) throw new Error('获取文件地址失败');
    return item.tempFileURL;
  }
  forSpatial() { return new CloudStore(this.env, { timeout: 5000 }); }
  async importSpatial(key, filename, options) { return uploadCloud(this.app, key, filename, { ...options, environment: this.env }); }
  async readSpatial(file, bytes, options) { return readCloud(this.app, file, bytes, { ...options, environment: this.env }); }
  async deleteSpatial(file) {
    const result = checked(await this.app.deleteFile({ fileList: [file] }, SDK_OPTIONS));
    const item = result.fileList?.[0];
    if (!item || (item.code && item.code !== 'SUCCESS' && item.code !== 'STORAGE_FILE_NONEXIST')) throw new Error('Spatial cleanup failed');
  }
}
module.exports = { LocalStore, CloudStore };
