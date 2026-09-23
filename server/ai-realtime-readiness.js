'use strict';
const { configuration, controlConfiguration, FLOW_MODELS } = require('./ai-realtime-trtc');
const json = value => { try { return JSON.parse(value); } catch { return null; } };
const filled = value => typeof value === 'string' && Boolean(value.trim());
function cloudbaseURL(env) {
  return /^[a-z0-9][a-z0-9-]{1,99}$/.test(env.MEMORY_CLOUDBASE_ENV || '')
    ? `https://${env.MEMORY_CLOUDBASE_ENV}.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions` : null;
}
function readiness(env = process.env) {
  // Validating an enabled copy never instantiates a client or changes env. This
  // deliberately catches missing configuration while the service stays off.
  const planned = configuration({ ...env, AI_REALTIME_ENABLED: '1' });
  const llm = json(env.AI_REALTIME_LLM_JSON), tts = json(env.AI_REALTIME_TTS_JSON), endpoint = cloudbaseURL(env);
  const names = ['AI_REALTIME_PROVIDER', 'AI_REALTIME_TRTC_APP_ID', 'AI_REALTIME_TRTC_SDK_SECRET',
    'AI_REALTIME_TRTC_SECRET_ID', 'AI_REALTIME_TRTC_SECRET_KEY', 'AI_REALTIME_LLM_JSON', 'AI_REALTIME_TTS_JSON'];
  const directCloudbase = Boolean(endpoint && llm?.APIUrl === endpoint && llm?.LLMType === 'openai' && llm?.Model === 'hy3');
  return { verification: 'configuration-only', networkRequests: 0, serviceEnabled: env.AI_REALTIME_ENABLED === '1',
    configurationReady: planned.enabled, reason: planned.reason,
    fields: Object.fromEntries(names.map(name => [name, filled(env[name]) ? 'present' : 'missing'])),
    cleanupControlReady: Boolean(controlConfiguration(env)), roomAuthAttested: env.AI_REALTIME_TRTC_ROOM_AUTH === '1',
    cleanupTriggerConfigured: env.AI_REALTIME_CLEANUP_ENABLED === '1', cleanupTriggerVerified: false,
    llm: { mode: directCloudbase ? 'cloudbase-hy3-direct' : 'other-or-incomplete', apiKeyPresent: filled(llm?.APIKey),
      credentialScope: directCloudbase ? 'cloudbase-api-key-has-administrator-permissions' : 'unverified',
      httpStreamVerified: false, trtcStreamVerified: false, trtcAcceptHeaderVerified: false },
    tts: { supportedModels: FLOW_MODELS, model: FLOW_MODELS.includes(tts?.Model) ? tts.Model : 'missing-or-unsupported',
      voicePresent: filled(tts?.VoiceId), legacyModel: tts?.Model === 'flow_01_turbo', providerVerified: false },
    remaining: ['TRTC activation and billing', 'TRTC cloud API permissions', 'Room permission enforcement',
      'LLM credential scope decision', 'TRTC to LLM streaming including Accept header', 'Flow model and voice entitlement',
      'Independent cleanup Timer deployment and observed execution', 'Real microphone, speaker and interruption test'] };
}
async function probeCloudbase(env, { fetcher = fetch, timeoutMs = 30000 } = {}) {
  // Only an explicit caller invokes this chargeable text-only probe. Pin the
  // existing environment's gateway; no arbitrary configured URL or redirects.
  const llm = json(env.AI_REALTIME_LLM_JSON), endpoint = cloudbaseURL(env);
  const base = { verification: 'local-http-stream-only', trtcStreamVerified: false, trtcAcceptHeaderVerified: false };
  if (!endpoint || llm?.APIUrl !== endpoint || llm?.LLMType !== 'openai' || llm?.Model !== 'hy3' || !filled(llm?.APIKey))
    return { ...base, ok: false, code: 'DIRECT_CLOUDBASE_CONFIG_REQUIRED', networkRequests: 0 };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader, bytes = 0, events = 0, textReceived = false, done = false, buffer = '', httpStatus;
  try {
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${llm.APIKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: '请只回答：你好。' }], stream: true, max_tokens: 64, enable_thinking: false }) });
    httpStatus = response.status;
    if (!response.ok) return { ...base, ok: false, code: 'HTTP_REJECTED', httpStatus, networkRequests: 1 };
    if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body)
      return { ...base, ok: false, code: 'SSE_REQUIRED', httpStatus, networkRequests: 1 };
    reader = response.body.getReader(); const decoder = new TextDecoder();
    while (!done) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65536) throw Error('limit');
      buffer += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { done = true; break; }
        const chunk = JSON.parse(data); if (chunk.error) throw Error('provider');
        events++;
        const content = chunk.choices?.[0]?.delta?.content;
        textReceived ||= typeof content === 'string' && Boolean(content.trim());
      }
    }
    return { ...base, ok: done && textReceived, code: done && textReceived ? 'SSE_TEXT_COMPLETE' : 'SSE_INCOMPLETE',
      httpStatus, networkRequests: 1, bytes, events, textReceived, done };
  } catch {
    return { ...base, ok: false, code: controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_OR_STREAM_FAILED', networkRequests: 1,
      ...(httpStatus ? { httpStatus } : {}) };
  } finally {
    controller.abort(); clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* No body, URL, key, or model output is logged. */ }
  }
}
module.exports = { readiness, probeCloudbase };
