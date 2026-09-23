'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, postReport, createReport, parseArguments, validateEndpoint, readLines, configuration } = require('../presence_uploader.cjs');
const token = () => ['ps1', crypto.randomUUID(), crypto.randomBytes(32).toString('hex')].join('.');
const event = (values = {}) => ({ type: 'presence.dwell', timestamp: Date.now(), dwellMs: 4200, headCount: 1, ...values });
const line = values => 'EVENT:' + JSON.stringify(event(values)) + '\n';
const report = () => createReport(event());
const opts = (...extra) => parseArguments(['--stdin', '--endpoint', 'http://127.0.0.1:9/api', ...extra], {});
const env = () => ({ PRESENCE_SENSOR_TOKEN: token(), PRESENCE_DEVICE_ID: 'review-camera' });
const success = () => new Response('', { status: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('once stops an open stdin after the first fresh event and never schedules extra events', async () => {
  const input = new PassThrough(), logs = [];
  const promise = run(opts('--once', '--dry-run'), { env: {}, input, log: value => logs.push(value) });
  input.write(line() + line());
  assert.equal(await promise, 0); assert.equal(logs.filter(value => value.includes('dry-run {')).length, 1);
  assert.equal(input.listenerCount('data'), 0); assert.equal(input.isPaused(), true);
});
test('dry-run EOF drains bounded work without hanging; --once with no valid event reports exit 3', async () => {
  const logs = [];
  assert.equal(await run(opts('--dry-run'), { env: {}, input: Readable.from([line()]), log: v => logs.push(v) }), 0);
  assert.equal(logs.filter(v => v.includes('dry-run {')).length, 1);
  assert.equal(await run(opts('--dry-run', '--once'), { env: {}, input: Readable.from(['diagnostic\n']), log() {} }), 3);
});
test('one active upload and only the latest pending event are retained under a burst', async () => {
  const input = new PassThrough(), sent = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const promise = run(opts(), { env: env(), input, log() {}, fetchImpl: async (_url, request) => {
    sent.push(JSON.parse(request.body)); if (sent.length === 1) await blocked; return success();
  } });
  input.write(line({ dwellMs: 1000 })); await tick();
  for (let i = 0; i < 200; i++) input.write(line({ dwellMs: 2000 + i }));
  input.end(); release(); assert.equal(await promise, 0);
  assert.equal(sent.length, 2); assert.equal(sent[0].data.dwellMs, 1000); assert.equal(sent[1].data.dwellMs, 2199);
});
test('stop aborts an in-flight upload, removes input/signal listeners and drops pending events', async () => {
  const input = new PassThrough(), stop = new AbortController(); let requests = 0, aborted = 0;
  const before = process.listenerCount('SIGINT');
  const pending = run(opts(), { env: env(), input, signal: stop.signal, log() {}, fetchImpl: (_url, request) => {
    requests++; return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => { aborted++; reject(Error('synthetic abort')); }, { once: true }));
  } });
  input.write(line()); await tick(); input.write(line()); stop.abort();
  assert.equal(await pending, 130); assert.equal(requests, 1); assert.equal(aborted, 1);
  assert.equal(input.listenerCount('data'), 0); assert.equal(process.listenerCount('SIGINT'), before);
});
test('abort cancels retry backoff immediately without issuing another request', async () => {
  const stop = new AbortController(); let count = 0;
  const pending = postReport(report(), { endpoint: 'http://127.0.0.1/api', signal: stop.signal, fetchImpl: async () => { count++; return new Response('', { status: 503 }); } });
  await tick(); stop.abort(); await assert.rejects(pending, { code: 'stopped' }); assert.equal(count, 1);
});
test('stale/future events never upload and an expired queued event is dropped', async () => {
  let time = Date.now(), sent = 0, release;
  const input = new PassThrough(), blocked = new Promise(resolve => { release = resolve; });
  const promise = run(opts(), { env: env(), input, clock: () => time, log() {}, fetchImpl: async () => { sent++; if (sent === 1) await blocked; return success(); } });
  input.write(line({ timestamp: time - 31000 }) + line({ timestamp: time + 31000 }) + line({ timestamp: time }));
  await tick(); input.write(line({ timestamp: time })); input.end(); time += 31000; release();
  assert.equal(await promise, 2); assert.equal(sent, 1);
});
test('permanent errors are not retried; reflected credential text is never read or logged', async () => {
  const synthetic = token(), logs = []; let count = 0, cancelled = 0;
  const result = await run(opts('--once'), { env: { PRESENCE_SENSOR_TOKEN: synthetic }, input: Readable.from([line()]), log: value => logs.push(value),
    fetchImpl: async () => { count++; return { status: 401, ok: false, body: { cancel: async () => { cancelled++; } }, text: () => { throw Error(synthetic); } }; } });
  assert.equal(result, 2); assert.equal(count, 1); assert.equal(cancelled, 1);
  assert.ok(!logs.join('\n').includes(synthetic)); assert.match(logs.join('\n'), /HTTP 401/);
});
test('network exception text is sanitized and all retries retain the same event id', async () => {
  const synthetic = token(), ids = [];
  await assert.rejects(postReport(report(), { endpoint: 'http://127.0.0.1/api', attempts: 2, baseDelayMs: 0,
    fetchImpl: async (_url, request) => { ids.push(JSON.parse(request.body).data.eventId); throw Error('secret=' + synthetic); } }), error => error.message === 'network-failure' && !error.message.includes(synthetic));
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});
test('timeout cancels hanging requests and does not wait for unbounded response bodies', async () => {
  await assert.rejects(postReport(report(), { endpoint: 'http://127.0.0.1/api', attempts: 1, timeoutMs: 15, fetchImpl: (_url, request) =>
    new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Error('abort')))) }), { code: 'request-timeout' });
});
test('endpoint rejects credential/query/fragment URLs without echoing them; redirects are disabled', async () => {
  const synthetic = token();
  for (const endpoint of ['https://user:' + synthetic + '@example.invalid/api', 'https://example.invalid/api?token=' + synthetic, 'https://example.invalid/api#' + synthetic]) {
    assert.throws(() => validateEndpoint(endpoint, synthetic), error => !error.message.includes(synthetic));
  }
  await postReport(report(), { endpoint: 'http://127.0.0.1/api', fetchImpl: async (_url, request) => { assert.equal(request.redirect, 'error'); return success(); } });
});
test('oversized lines are discarded until newline without poisoning the next event', async () => {
  const input = new PassThrough(), lines = [];
  const finished = new Promise(resolve => readLines(input, line => lines.push(line), resolve, assert.fail));
  for (let i = 0; i < 64; i++) input.write('x'.repeat(4096));
  input.end('\n' + line()); await finished;
  assert.equal(lines.length, 1); assert.ok(lines[0].startsWith('EVENT:'));
});
test('private config is explicit and complete, resolves demo relative to itself, and rejects legacy tokens', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link2-private-config-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('link2-private-config-test-')); await fs.rm(dir, { recursive: true, force: true }); });
  const filename = path.join(dir, 'sensor.private.json'), synthetic = token();
  await fs.writeFile(filename, JSON.stringify({ endpoint: 'http://127.0.0.1:1234/api', deviceId: 'paired-camera', sensorToken: synthetic, demoPath: 'bin/demo.exe' }));
  const config = configuration(parseArguments(['--config', filename], {}), { PRESENCE_SENSOR_TOKEN: 'old-MVP-shared-token', PRESENCE_DEVICE_ID: 'wrong-device' });
  assert.equal(config.token, synthetic); assert.equal(config.deviceId, 'paired-camera'); assert.equal(config.demo, path.join(dir, 'bin/demo.exe'));
  assert.equal(configuration(parseArguments(['--config', filename, '--endpoint', 'http://127.0.0.1:4321/api'], {}), {}).endpoint, 'http://127.0.0.1:4321/api');
  await fs.writeFile(filename, JSON.stringify({ endpoint: 'http://127.0.0.1/api', deviceId: 'camera', sensorToken: 'old-mvp-token' }));
  assert.throws(() => configuration(parseArguments(['--config', filename], {}), {}), /legacy MVP/);
  await fs.writeFile(filename, '{"sensorToken":"DO-NOT-ECHO",');
  assert.throws(() => configuration(parseArguments(['--config', filename], {}), {}), error => !error.message.includes('DO-NOT-ECHO'));
});
test('child process never receives presence credentials, and spawn failure settles without hanging', async () => {
  const input = new PassThrough(), secret = token(); let child;
  const result = await run({ ...opts('--once'), stdin: false, demo: __filename }, { env: { PRESENCE_SENSOR_TOKEN: secret, PRESENCE_ENDPOINT: 'http://127.0.0.1/api' }, log() {},
    spawnImpl: (_exe, _args, options) => {
      assert.equal(options.env.PRESENCE_SENSOR_TOKEN, undefined); assert.equal(options.env.PRESENCE_ENDPOINT, undefined); assert.equal(options.windowsHide, true);
      child = new EventEmitter(); child.stdout = input; child.stderr = new PassThrough(); child.kill = () => { child.killed = true; };
      queueMicrotask(() => child.emit('error', Error(secret))); return child;
    } });
  assert.equal(result, 1); assert.equal(child.killed, true);
});
test('actual Node CLI --once exits with stdin still open and produces exactly one report', async () => {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../presence_uploader.cjs'), '--stdin', '--once', '--dry-run'],
    { env: { ...process.env, PRESENCE_SENSOR_TOKEN: '', PRESENCE_DEVICE_ID: 'review-camera' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 5000);
  try { child.stdin.write(line() + line()); const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.equal((output.match(/dry-run \{/g) || []).length, 1); }
  finally { clearTimeout(timeout); child.kill(); }
});
