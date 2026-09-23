'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readiness, probeCloudbase } = require('../server/ai-realtime-readiness');
const { createTRTC, configuration } = require('../server/ai-realtime-trtc');
function configured() {
  return { AI_REALTIME_ENABLED: '0', AI_REALTIME_PROVIDER: 'tencent-trtc', MEMORY_CLOUDBASE_ENV: 'existing-test-env',
    AI_REALTIME_TRTC_APP_ID: '123456', AI_REALTIME_TRTC_ROOM_AUTH: '1', AI_REALTIME_TRTC_SDK_SECRET: 'private-signing',
    AI_REALTIME_TRTC_SECRET_ID: 'private-id', AI_REALTIME_TRTC_SECRET_KEY: 'private-secret',
    AI_REALTIME_LLM_JSON: JSON.stringify({ LLMType: 'openai', Model: 'hy3', APIKey: 'private-llm',
      APIUrl: 'https://existing-test-env.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions' }),
    AI_REALTIME_TTS_JSON: JSON.stringify({ TTSType: 'flow', Model: 'flow_02_turbo', VoiceId: 'private-voice' }) };
}
const safe = output => assert.doesNotMatch(JSON.stringify(output), /private-|existing-test-env|Authorization|Bearer|回答正文/);
const sse = chunks => new Response(new ReadableStream({ start(controller) {
  for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close();
} }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });

test('offline readiness validates disabled configuration without exposing or changing values', () => {
  const env = configured(), before = structuredClone(env), report = readiness(env);
  assert.deepEqual(env, before); assert.equal(configuration(env).enabled, false);
  assert.equal(report.serviceEnabled, false); assert.equal(report.configurationReady, true);
  assert.equal(report.networkRequests, 0); assert.equal(report.llm.mode, 'cloudbase-hy3-direct');
  assert.equal(report.llm.credentialScope, 'cloudbase-api-key-has-administrator-permissions');
  assert.equal(report.cleanupTriggerVerified, false); assert.equal(report.llm.trtcStreamVerified, false); safe(report);
  const empty = readiness({ AI_MODEL: 'hy3', TENCENTCLOUD_SECRETID: 'private-runtime', AI_VISION_API_KEY: 'private-vision' });
  assert.equal(empty.configurationReady, false); assert.equal(empty.cleanupControlReady, false); safe(empty);
  for (const key of ['AI_REALTIME_TRTC_SDK_SECRET', 'AI_REALTIME_TRTC_SECRET_ID', 'AI_REALTIME_TRTC_SECRET_KEY']) {
    assert.equal(readiness({ ...env, [key]: ' ' }).configurationReady, false);
    assert.equal(readiness({ ...env, [key]: 123 }).configurationReady, false);
  }
});

test('Flow 02 and legacy Flow 01 are explicit allowlisted models and retain selected model on wire', async () => {
  for (const model of ['flow_02_turbo', 'flow_01_turbo']) {
    const env = { ...configured(), AI_REALTIME_ENABLED: '1',
      AI_REALTIME_TTS_JSON: JSON.stringify({ TTSType: 'flow', Model: model, VoiceId: 'voice', APIKey: 'must-not-pass' }) };
    let request;
    const provider = createTRTC({ env, client: { StartAIConversation: async input => { request = input; return { TaskId: 'task' }; } },
      signer: { genPrivateMapKeyWithStringRoomID: () => 'sig' } });
    assert.equal(configuration(env).enabled, true); await provider.start({});
    assert.deepEqual(JSON.parse(request.TTSConfig), { TTSType: 'flow', VoiceId: 'voice', Model: model, Speed: 1, Language: 'zh' });
    assert.equal(readiness(env).tts.legacyModel, model === 'flow_01_turbo');
  }
  for (const model of ['', 'flow_01_ex', 'arbitrary-model']) {
    const env = { ...configured(), AI_REALTIME_ENABLED: '1', AI_REALTIME_TTS_JSON: JSON.stringify({ TTSType: 'flow', Model: model, VoiceId: 'voice' }) };
    assert.equal(configuration(env).enabled, false);
    assert.equal(readiness(env).tts.model, 'missing-or-unsupported');
  }
});

test('opt-in probe pins hy3 gateway and emits only completed SSE evidence, never answer or keys', async () => {
  let calls = 0;
  const report = await probeCloudbase(configured(), { fetcher: async (url, options) => {
    calls++; assert.equal(url, JSON.parse(configured().AI_REALTIME_LLM_JSON).APIUrl);
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Accept, 'text/event-stream');
    assert.equal(options.headers.Authorization, 'Bearer private-llm');
    const body = JSON.parse(options.body); assert.equal(body.model, 'hy3'); assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 64); assert.equal(body.messages.length, 1); assert.equal(body.tools, undefined);
    return sse([': keepalive\r\n\r\n', 'data: {"choices":[{"delta":{"content":"回答正文"}}]}\r', '\n\r\n', 'data: [DONE]\n\n']);
  } });
  assert.equal(calls, 1); assert.equal(report.ok, true); assert.equal(report.done, true);
  assert.equal(report.verification, 'local-http-stream-only'); assert.equal(report.trtcStreamVerified, false); safe(report);
});

test('probe refuses arbitrary URLs, environment mismatches, unsupported models and missing keys before I/O', async () => {
  const env = configured(), original = JSON.parse(env.AI_REALTIME_LLM_JSON);
  for (const changes of [{ APIUrl: 'https://evil.example/api' }, { APIUrl: original.APIUrl + '?secret=private-url' },
    { APIUrl: original.APIUrl.replace('existing-test-env', 'another-env') }, { Model: 'another' }, { APIKey: '' }]) {
    const report = await probeCloudbase({ ...env, AI_REALTIME_LLM_JSON: JSON.stringify({ ...original, ...changes }) },
      { fetcher: () => { throw Error('must not fetch'); } });
    assert.equal(report.networkRequests, 0); assert.equal(report.ok, false); safe(report);
  }
});

test('probe rejects HTTP errors, non-SSE, incomplete/malformed/oversize SSE and provider errors without leaks', async () => {
  for (const response of [new Response('private-key-and-response', { status: 401 }),
    new Response('{"content":"回答正文"}', { headers: { 'Content-Type': 'application/json' } }),
    sse(['data: {"choices":[{"delta":{"content":"回答正文"}}]}\n\n']),
    sse(['data: [DONE]\n\n']), sse(['data: private-invalid\n\n']),
    sse(['data: {"error":{"message":"private-error"}}\n\n']), sse(['x'.repeat(65537)])]) {
    const report = await probeCloudbase(configured(), { fetcher: async () => response });
    assert.equal(report.ok, false); assert.equal(report.networkRequests, 1); safe(report);
  }
  safe(await probeCloudbase(configured(), { fetcher: async () => { throw Error('private-network-url'); } }));
});

test('probe aborts the network deadline without leaking request details', async () => {
  const report = await probeCloudbase(configured(), { timeoutMs: 10, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('private-timeout')), { once: true });
  }) });
  assert.equal(report.code, 'TIMEOUT'); safe(report);
});

test('offline CLI reads only selected deployment variables and fails safely on malformed input', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unseen-readiness-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'private.json'), script = path.resolve(__dirname, '../scripts/check-trtc-readiness.mjs');
  await fs.writeFile(file, JSON.stringify({ functions: [{ name: 'unrelated', envVariables: { secret: 'private-unrelated' } },
    { name: 'memory-frame-demo', envVariables: configured() }] }));
  const result = await promisify(execFile)(process.execPath, [script, '--config', file]);
  const report = JSON.parse(result.stdout); assert.equal(report.networkRequests, 0); assert.equal(report.serviceEnabled, false); safe(report);
  await fs.writeFile(file, 'private-invalid-json');
  await assert.rejects(promisify(execFile)(process.execPath, [script, '--config', file]), error => {
    assert.equal(error.code, 1); assert.doesNotMatch(error.stderr, /private-invalid-json/);
    assert.equal(JSON.parse(error.stderr).code, 'READINESS_INPUT_INVALID'); return true;
  });
});
