'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  parseEventLine,
  createReport,
  validateEndpoint,
  postReport,
  parseArguments,
} = require('../presence_uploader.cjs');

test('parses the Demo presence.dwell line', () => {
  const event = parseEventLine('[demo] EVENT:{"type":"presence.dwell","timestamp":1234567890,"dwellMs":4200,"headCount":1}');
  assert.deepEqual(event, { type: 'presence.dwell', timestamp: 1234567890, dwellMs: 4200, headCount: 1 });
  assert.equal(parseEventLine('[Tracking] sdk=ok'), null);
});

test('rejects malformed or unsafe Demo events', () => {
  assert.throws(() => parseEventLine('EVENT:not-json'), /valid JSON/);
  assert.throws(() => parseEventLine('EVENT:{"type":"other","timestamp":1,"dwellMs":1,"headCount":1}'), /Unsupported/);
  assert.throws(() => parseEventLine('EVENT:{"type":"presence.dwell","timestamp":1,"dwellMs":1,"headCount":11}'), /Link SDK range/);
});

test('creates the agreed idempotent cloud contract', () => {
  const report = createReport({ timestamp: 10, dwellMs: 4000, headCount: 1 }, { eventId: 'event-1', deviceId: 'living-room' });
  assert.deepEqual(report, { action: 'presenceReport', data: {
    version: 1,
    eventId: 'event-1',
    source: 'link2-windows',
    deviceId: 'living-room',
    type: 'presence.dwell',
    occurredAt: 10,
    dwellMs: 4000,
    headCount: 1,
  } });
});

test('requires HTTPS and authentication away from loopback', () => {
  assert.throws(() => validateEndpoint('http://example.com/api', 'token'), /must use HTTPS/);
  assert.throws(() => validateEndpoint('https://example.com/api', ''), /TOKEN is required/);
  assert.equal(validateEndpoint('http://127.0.0.1:1234/api', '').hostname, '127.0.0.1');
});

test('keeps the same event id while retrying a temporary HTTP failure', async t => {
  const bodies = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (bodies.length === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"temporary"}');
    } else {
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end('{"accepted":true}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/api`;
  // The integrated uploader intentionally rejects stale events; use a fresh timestamp.
  const report = createReport({ timestamp: Date.now(), dwellMs: 4000, headCount: 1 }, { eventId: 'same-id' });
  const result = await postReport(report, { endpoint, attempts: 2, baseDelayMs: 1 });
  assert.equal(result.status, 202);
  assert.equal(result.attempt, 2);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].data.eventId, 'same-id');
  assert.equal(bodies[1].data.eventId, 'same-id');
});

test('parses command line options', () => {
  assert.deepEqual(parseArguments(['--stdin', '--once', '--dry-run', '--endpoint', 'http://127.0.0.1/api']), {
    demo: '', endpoint: 'http://127.0.0.1/api', dryRun: true, stdin: true, once: true,
  });
});
