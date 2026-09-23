'use strict';
// Based on the supplied Link 2 uploader. See UPSTREAM.md for provenance and changes.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const DEFAULT_ENDPOINT = 'https://example.invalid/api';
const MAX_LINE_BYTES = 2048, MAX_EVENT_AGE_MS = 30000, MAX_FUTURE_SKEW_MS = 30000;
const DEVICE = /^[a-zA-Z0-9._-]{1,64}$/;
const SENSOR_TOKEN = /^ps1\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[a-f0-9]{64}$/;
class UploadError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
function parseEventLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE_BYTES) throw new UploadError('EVENT line exceeds size limit');
  const marker = line.indexOf('EVENT:'); if (marker < 0) return null;
  let event;
  try { event = JSON.parse(line.slice(marker + 6).trim()); } catch { throw new UploadError('EVENT line is not valid JSON'); }
  if (!event || event.type !== 'presence.dwell') throw new UploadError('Unsupported EVENT type');
  if (Object.keys(event).some(key => !['type', 'timestamp', 'dwellMs', 'headCount'].includes(key))) throw new UploadError('Unexpected EVENT fields');
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp <= 0) throw new UploadError('EVENT timestamp must be a positive integer');
  if (!Number.isSafeInteger(event.dwellMs) || event.dwellMs < 0 || event.dwellMs > 3600000) throw new UploadError('EVENT dwellMs is outside the accepted range');
  if (!Number.isSafeInteger(event.headCount) || event.headCount < 0 || event.headCount > 10) throw new UploadError('EVENT headCount is outside the Link SDK range');
  return Object.freeze({ type: event.type, timestamp: event.timestamp, dwellMs: event.dwellMs, headCount: event.headCount });
}
function createReport(event, options = {}) {
  return Object.freeze({ action: 'presenceReport', data: Object.freeze({ version: 1, eventId: options.eventId || crypto.randomUUID(),
    source: 'link2-windows', deviceId: options.deviceId || 'living-room-link2', type: 'presence.dwell',
    occurredAt: event.timestamp, dwellMs: event.dwellMs, headCount: event.headCount }) });
}
function isLoopback(url) { return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); }
function validateEndpoint(value, token) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new UploadError('PRESENCE_ENDPOINT is not a valid URL'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api') throw new UploadError('Endpoint must end in /api without credentials, query or fragment');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLoopback(endpoint))) throw new UploadError('The cloud endpoint must use HTTPS; HTTP is allowed only for loopback testing');
  if (!token && !isLoopback(endpoint)) throw new UploadError('PRESENCE_SENSOR_TOKEN is required for a cloud endpoint');
  return endpoint;
}
function fresh(report, now) {
  return Number.isSafeInteger(report?.data?.occurredAt) && report.data.occurredAt > now - MAX_EVENT_AGE_MS && report.data.occurredAt <= now + MAX_FUTURE_SKEW_MS;
}
async function postReport(report, options = {}) {
  const endpoint = validateEndpoint(options.endpoint || DEFAULT_ENDPOINT, options.token);
  const clock = options.clock || Date.now, attempts = options.attempts ?? 5, timeoutMs = options.timeoutMs ?? 5000, baseDelayMs = options.baseDelayMs ?? 1000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 1000) throw new UploadError('Invalid retry settings');
  const expiresAt = options.expiresAt ?? Math.min(clock() + MAX_EVENT_AGE_MS, report.data.occurredAt + MAX_EVENT_AGE_MS);
  const deadline = new AbortController(), stop = () => deadline.abort();
  if (options.signal?.aborted) throw new UploadError('stopped');
  options.signal?.addEventListener('abort', stop, { once: true });
  const life = setTimeout(() => deadline.abort(), Math.max(1, expiresAt - clock()));
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (options.signal?.aborted) throw new UploadError('stopped');
      if (deadline.signal.aborted || clock() >= expiresAt || !fresh(report, clock())) throw new UploadError('event-expired');
      const request = new AbortController(), abort = () => request.abort();
      deadline.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.min(timeoutMs, Math.max(1, expiresAt - clock())));
      let failure;
      try {
        const response = await (options.fetchImpl || fetch)(endpoint, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}) },
          body: JSON.stringify(report), signal: request.signal });
        // Response text can reflect a credential or be unbounded. Never retain/log it.
        try { await response.body?.cancel(); } catch {}
        if (options.signal?.aborted) throw new UploadError('stopped');
        if (deadline.signal.aborted || clock() >= expiresAt) throw new UploadError('event-expired');
        if (response.ok) return { attempt, status: response.status };
        failure = new UploadError('HTTP ' + response.status, response.status);
        if (![408, 425, 429].includes(response.status) && response.status < 500) throw failure;
      } catch (error) {
        if (error instanceof UploadError) throw error;
        failure = new UploadError(request.signal.aborted ? 'request-timeout' : 'network-failure');
      } finally { clearTimeout(timer); deadline.signal.removeEventListener('abort', abort); }
      if (options.signal?.aborted) throw new UploadError('stopped');
      if (deadline.signal.aborted || clock() >= expiresAt) throw new UploadError('event-expired');
      if (attempt === attempts) throw failure;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      if (clock() + delay >= expiresAt) throw new UploadError('event-expired');
      try { await sleep(delay, undefined, { signal: deadline.signal }); }
      catch { throw new UploadError(options.signal?.aborted ? 'stopped' : 'event-expired'); }
    }
  } finally { clearTimeout(life); options.signal?.removeEventListener('abort', stop); }
}
function parseArguments(argv, env = process.env) {
  const result = { demo: '', endpoint: env.PRESENCE_ENDPOINT || DEFAULT_ENDPOINT, dryRun: false, stdin: false, once: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--demo', '--endpoint', '--config'].includes(argument)) {
      const value = argv[++index]; if (!value || value.startsWith('--')) throw new UploadError('Option requires a value');
      result[argument.slice(2)] = value;
      if (argument === '--endpoint') Object.defineProperty(result, 'explicitEndpoint', { value: true });
    } else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--stdin') result.stdin = true;
    else if (argument === '--once') result.once = true;
    else if (argument === '--check-config') result.checkConfig = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw new UploadError('Unknown command-line option'); // Never echo arbitrary arguments (including a pasted token).
  }
  return result;
}
function readPrivateConfig(filename) {
  let data;
  try {
    if (!fs.statSync(filename).isFile() || fs.statSync(filename).size > 8192) throw Error();
    data = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  } catch { throw new UploadError('Cannot read private JSON config (maximum 8 KiB)'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['endpoint', 'deviceId', 'sensorToken', 'demoPath'].includes(key)) ||
      ['endpoint', 'deviceId', 'sensorToken'].some(key => typeof data[key] !== 'string' || !data[key]) ||
      (data.demoPath !== undefined && typeof data.demoPath !== 'string')) throw new UploadError('Private config requires endpoint, deviceId and sensorToken; optional demoPath only');
  return data;
}
function configuration(options, env = process.env) {
  const privateConfig = options.config ? readPrivateConfig(options.config) : null;
  const token = privateConfig ? privateConfig.sensorToken : env.PRESENCE_SENSOR_TOKEN || '';
  const deviceId = privateConfig ? privateConfig.deviceId : env.PRESENCE_DEVICE_ID || 'living-room-link2';
  // Explicit config is a complete credential binding, never silently combined with old MVP files.
  const endpoint = options.explicitEndpoint ? options.endpoint : privateConfig?.endpoint || options.endpoint || DEFAULT_ENDPOINT;
  if (!DEVICE.test(deviceId)) throw new UploadError('PRESENCE_DEVICE_ID must contain 1-64 letters, digits, dots, underscores, or hyphens');
  if ((!options.dryRun || privateConfig || token) && !SENSOR_TOKEN.test(token)) throw new UploadError('Use a current ps1 sensor token issued for this device and frame; legacy MVP tokens are not supported');
  validateEndpoint(endpoint, token || (options.dryRun ? 'dry-run' : ''));
  const configuredDemo = privateConfig?.demoPath ? path.resolve(path.dirname(path.resolve(options.config)), privateConfig.demoPath) : '';
  return { token, deviceId, endpoint, demo: options.demo || configuredDemo };
}
function findDemo(explicitPath = '') {
  const candidates = explicitPath ? [explicitPath] : [path.join(__dirname, 'build', 'Release', 'link2_dwell_demo.exe'), path.join(__dirname, 'build', 'link2_dwell_demo.exe')];
  const match = candidates.map(item => path.resolve(item)).find(item => { try { return fs.statSync(item).isFile(); } catch { return false; } });
  if (!match) throw new UploadError('Cannot find link2_dwell_demo.exe. Build it or provide --demo PATH');
  return match;
}
// A bounded line splitter: a malformed producer cannot grow readline's buffer indefinitely.
function readLines(input, onLine, onEnd, onError) {
  let parts = [], length = 0, dropping = false, ended = false;
  const line = () => { if (!dropping) onLine(Buffer.concat(parts, length).toString('utf8').replace(/\r$/, '')); parts = []; length = 0; dropping = false; };
  const data = chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let i = 0; i <= buffer.length; i++) if (i === buffer.length || buffer[i] === 10) {
      const piece = buffer.subarray(start, i);
      if (!dropping && length + piece.length <= MAX_LINE_BYTES) { parts.push(Buffer.from(piece)); length += piece.length; }
      else { dropping = true; parts = []; length = 0; }
      if (i < buffer.length) line(); start = i + 1;
    }
  };
  const end = () => { if (ended) return; ended = true; if (length) line(); onEnd(); };
  input.on('data', data); input.once('end', end); input.once('error', onError);
  return () => { ended = true; parts = []; input.removeListener('data', data); input.removeListener('end', end); input.removeListener('error', onError); input.pause(); };
}
async function run(options, dependencies = {}) {
  const env = dependencies.env || process.env, config = configuration(options, env), log = dependencies.log || console.log, clock = dependencies.clock || Date.now;
  if (options.checkConfig) { log('[presence] configuration valid; deviceId=' + config.deviceId + '; transport=' + (isLoopback(new URL(config.endpoint)) ? 'loopback' : 'HTTPS')); return 0; }
  let child, childClosed = false, detach = () => {}, closedInput = false, active = null, pending = null, captured = false, handled = 0, exitCode = 0, stopped = false;
  const abort = new AbortController(); let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const stop = (code = 0) => { if (stopped) return; stopped = true; exitCode ||= code; pending = null; abort.abort(); detach(); child?.kill(); finish(); };
  const signalStop = () => stop(130);
  const reportError = error => error instanceof UploadError ? error.code : 'operation-failed';
  const drain = () => {
    if (stopped || active) return;
    if (!pending) { if (closedInput && (!child || childClosed)) finish(); return; }
    const item = pending; pending = null;
    active = (async () => {
      await Promise.resolve(); // Assign active before a synchronous dry-run can finish.
      try {
        if (!fresh(item.report, clock()) || clock() >= item.expiresAt) { log('[presence] dropped expired eventId=' + item.report.data.eventId); exitCode ||= 2; return; }
        if (options.dryRun) log('[presence] dry-run ' + JSON.stringify(item.report));
        else {
          const result = await postReport(item.report, { endpoint: config.endpoint, token: config.token, signal: abort.signal,
            expiresAt: item.expiresAt, clock, fetchImpl: dependencies.fetchImpl });
          log('[presence] uploaded eventId=' + item.report.data.eventId + ' status=' + result.status + ' attempt=' + result.attempt);
        }
        handled++;
      } catch (error) {
        if (!stopped) { log('[presence] upload failed eventId=' + item.report.data.eventId + ': ' + reportError(error)); exitCode ||= 2; }
        if ([401, 403].includes(error.status)) stop(2);
      } finally {
        active = null;
        if (options.once) stop(exitCode);
        else queueMicrotask(drain);
      }
    })();
  };
  const onLine = line => {
    if (stopped || (options.once && captured)) return;
    let event;
    try { event = parseEventLine(line); } catch { log('[presence] ignored malformed event'); return; }
    if (!event) return;
    const report = createReport(event, { deviceId: config.deviceId });
    if (!fresh(report, clock())) { log('[presence] ignored stale event or clock skew'); return; }
    captured = true;
    log('[presence] captured presence.dwell eventId=' + report.data.eventId);
    if (pending) log('[presence] dropped superseded eventId=' + pending.report.data.eventId);
    pending = { report, expiresAt: Math.min(clock() + MAX_EVENT_AGE_MS, event.timestamp + MAX_EVENT_AGE_MS) };
    drain();
  };
  const inputFailed = () => { log('[presence] input failed'); stop(1); };
  try {
    process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
    dependencies.signal?.addEventListener('abort', signalStop, { once: true });
    if (dependencies.signal?.aborted) { stop(130); return exitCode; }
    let input = dependencies.input || process.stdin;
    if (!options.stdin) {
      const executable = findDemo(config.demo);
      const childEnv = { ...env }; for (const key of Object.keys(childEnv)) if (key.startsWith('PRESENCE_')) delete childEnv[key];
      child = (dependencies.spawnImpl || spawn)(executable, [], { cwd: path.dirname(executable), env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      // Raw SDK output is not forwarded: it may include device information or arbitrary text.
      child.stderr?.resume(); input = child.stdout;
      child.once('error', () => { log('[presence] Demo failed to start'); stop(1); });
      child.once('close', code => { childClosed = true; if (!stopped) { if (code !== 0) exitCode ||= 1; closedInput = true; drain(); } });
    }
    log('[presence] ' + (options.stdin ? 'reading stdin' : 'camera process started') + (options.dryRun ? '; dry-run' : '; HTTPS upload (loopback HTTP allowed)'));
    detach = readLines(input, onLine, () => { closedInput = true; drain(); }, inputFailed);
    await finished;
    await active;
    if (options.once && handled === 0 && !exitCode) exitCode = 3;
    return exitCode;
  } finally {
    stopped = true; pending = null; abort.abort(); detach(); child?.kill();
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
    dependencies.signal?.removeEventListener('abort', signalStop);
  }
}
function printHelp() {
  console.log('Usage: node presence_uploader.cjs [--config PRIVATE.json] [--demo PATH] [--endpoint HTTPS_API]\n' +
    '  --stdin         read EVENT lines without opening a camera\n  --dry-run       parse only; do not upload\n' +
    '  --once          handle at most one fresh valid event, then stop input/child\n  --check-config  validate configuration; no camera or network\n' +
    'Environment (when --config is absent): PRESENCE_SENSOR_TOKEN, PRESENCE_DEVICE_ID, PRESENCE_ENDPOINT.\n' +
    'Use only current frame-issued ps1 sensor tokens. Ctrl+C cancels upload and discards queued events.');
}
async function main() {
  try { const options = parseArguments(process.argv.slice(2)); if (options.help) return printHelp(); process.exitCode = await run(options); }
  catch (error) { console.error('[presence] ' + (error instanceof UploadError ? error.code : 'Startup failed; check configuration and runtime')); process.exitCode = 1; }
}
if (require.main === module) void main();
module.exports = { DEFAULT_ENDPOINT, MAX_EVENT_AGE_MS, parseEventLine, createReport, validateEndpoint, postReport, findDemo, parseArguments, configuration, readPrivateConfig, readLines, run, UploadError };
