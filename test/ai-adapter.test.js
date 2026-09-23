'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server/ai.js'), 'utf8');
function load(env = {}, overrides = {}) {
  const context = { module: { exports: {} }, require, Buffer, URL, FormData, Blob, AbortSignal, setTimeout, clearTimeout, process: { env }, fetch: async () => { throw Error('Unexpected network'); }, ...overrides };
  vm.runInNewContext(source, context); return context.module.exports;
}
function wav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 32000); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
const original = '1998年我和妈妈在北京合影。';
const card = { title: '与妈妈的合影', summary: '讲述者回忆1998年和妈妈在北京合影。', people: ['妈妈'], year: '1998年', place: '北京' };
const app = result => ({ ai: () => ({ createModel: provider => { assert.equal(provider, 'cloudbase'); return { generateText: async input => { assert.equal(input.model, 'hy3'); return result; } }; } }) });
test('CloudBase text response is strictly parsed and marked unconfirmed AI', async () => {
  const result = await load({ AI_MODEL: 'hy3' }).summarize(original, app({ text: JSON.stringify(card) }));
  assert.equal(result.source, 'ai'); assert.equal(result.confirmed, false); assert.equal(result.summary, card.summary);
});
test('rejects malformed, extra, mistyped, overlong and ungrounded model fields', async () => {
  for (const text of ['intro ' + JSON.stringify(card), JSON.stringify({ ...card, people: [4] }), JSON.stringify({ ...card, confirmed: true }), JSON.stringify({ ...card, title: '字'.repeat(21) }), JSON.stringify({ ...card, year: '1999年' }), 'null']) {
    await assert.rejects(load({ AI_MODEL: 'hy3' }).summarize(original, app({ text })), e => /^AI_(RESPONSE|UNGROUNDED)$/.test(e.code));
  }
});
test('accepts a whole JSON fence but not mixed prose', async () => {
  assert.equal((await load({ AI_MODEL: 'hy3' }).summarize(original, app({ text: '```json\n' + JSON.stringify(card) + '\n```' }))).place, '北京');
});
test('CloudBase returned error, rejected timeout and quota are actionable and sanitized', async () => {
  for (const [code, expected] of [['UnauthorizedOperation', 'AI_PERMISSION'], ['ResourceInsufficient', 'AI_QUOTA'], ['LimitExceeded', 'AI_QUOTA'], ['ETIMEDOUT', 'AI_TIMEOUT']]) {
    await assert.rejects(load({ AI_MODEL: 'hy3' }).summarize(original, app({ error: { code, message: 'SECRET must not leak' } })), e => e.code === expected && !e.message.includes('SECRET'));
  }
});
test('malformed WAV and >60 seconds are rejected before any external call', async () => {
  const invalid = wav(); invalid.writeUInt16LE(2, 22);
  for (const input of [Buffer.alloc(44), invalid, wav(61), wav().subarray(0, 80)]) await assert.rejects(load().transcribe(input), { code: 'AI_AUDIO_FORMAT' });
});
test('Tencent SDK receives byte length, base64, SCF credentials and token; supports exactly 60 seconds', async () => {
  let opts, payload;
  const api = load({ TENCENTCLOUD_SECRETID: 'test-id', TENCENTCLOUD_SECRETKEY: 'test-key', TENCENTCLOUD_SESSIONTOKEN: 'test-token' }, { require: name => name === 'tencentcloud-sdk-nodejs-asr' ? { asr: { v20190614: { Client: class { constructor(o) { opts = o; } async SentenceRecognition(p) { payload = p; return { Result: ' 原话 ' }; } } } } } : require(name) });
  const audio = wav(60); assert.equal(await api.transcribe(audio), '原话'); assert.equal(opts.credential.token, 'test-token'); assert.equal(payload.DataLen, audio.length); assert.equal(payload.Data, audio.toString('base64')); assert.equal(payload.EngSerViceType, '16k_zh');
});
test('partial configuration fails without fallback or credential mixing', async () => {
  await assert.rejects(load({ ASR_BASE_URL: 'https://example.test/v1' }).transcribe(wav()), { code: 'AI_CONFIG' });
  await assert.rejects(load({ TENCENTCLOUD_SECRETID: 'scf', TENCENT_SECRET_KEY: 'static' }).transcribe(wav()), { code: 'AI_CONFIG' });
  await assert.rejects(load({ AI_API_KEY: 'key', AI_MODEL: 'model' }).summarize(original, app({ text: JSON.stringify(card) })), { code: 'AI_CONFIG' });
});
test('OpenAI compatible ASR sends real WAV multipart; LLM parses choices', async () => {
  const api = load({ ASR_BASE_URL: 'https://example.test/v1/', ASR_API_KEY: 'test', AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'test', AI_MODEL: 'model' }, { fetch: async (url, options) => {
    if (url.endsWith('/audio/transcriptions')) { assert.equal(options.body.get('file').size, wav().length); assert.equal(options.body.get('response_format'), 'json'); return { ok: true, json: async () => ({ text: original }) }; }
    assert.equal(url, 'https://example.test/v1/chat/completions'); assert.equal(JSON.parse(options.body).messages[1].content, original); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(card) } }] }) };
  } });
  assert.equal(await api.transcribe(wav()), original); assert.equal((await api.summarize(original)).title, card.title);
});
test('HTTP failures and empty ASR are not fabricated as transcripts', async () => {
  const env = { ASR_BASE_URL: 'https://example.test/v1', ASR_API_KEY: 'test' };
  await assert.rejects(load(env, { fetch: async () => ({ ok: false, status: 401 }) }).transcribe(wav()), { code: 'AI_PERMISSION' });
  await assert.rejects(load(env, { fetch: async () => ({ ok: true, json: async () => ({ text: '' }) }) }).transcribe(wav()), { code: 'AI_NO_SPEECH' });
});
