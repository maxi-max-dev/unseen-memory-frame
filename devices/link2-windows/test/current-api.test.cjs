'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../../../server/server');
const { LocalStore } = require('../../../server/store');
const { parseEventLine, createReport, postReport } = require('../presence_uploader.cjs');

test('Windows uploader talks to the current frame API with a new isolated LocalStore and lost-ack retry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link2-current-api-test-'));
  const app = await createApp({ store: new LocalStore(dir), setupCode: 'isolated-link2-fixture', presence: { timers: false, log() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('link2-current-api-test-')); await fs.rm(dir, { recursive: true, force: true }); });
  const endpoint = 'http://127.0.0.1:' + app.server.address().port + '/api';
  async function api(action, data = {}, token) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') }, body: JSON.stringify({ action, data }) });
    assert.equal(response.status, 200, action); return response.json();
  }
  const owner = await api('create', { setupCode: 'isolated-link2-fixture' });
  const invitation = await api('invite', { role: 'frame' }, owner.token);
  const frame = await api('join', { invite: invitation.invite });
  const another = await api('join', { invite: invitation.invite });
  const targetFrameId = 's_' + crypto.createHash('sha256').update(frame.token).digest('hex');
  const issued = await api('presenceSensorIssue', { deviceId: 'living-room-link2', targetFrameId }, owner.token);
  const data = parseEventLine('EVENT:' + JSON.stringify({ type: 'presence.dwell', timestamp: Date.now(), dwellMs: 4200, headCount: 1 }));
  const report = createReport(data, { deviceId: 'living-room-link2' });
  let calls = 0;
  const uploaded = await postReport(report, { endpoint, token: issued.token, attempts: 2, baseDelayMs: 0,
    fetchImpl: async (url, request) => {
      calls++; const response = await fetch(url, request);
      if (calls === 1) { await response.body.cancel(); throw Error('simulate lost response after commit'); }
      return response;
    } });
  assert.equal(uploaded.status, 200); assert.equal(uploaded.attempt, 2);
  const state = await api('state', {}, frame.token);
  assert.equal(state.presenceEvent.eventId, report.data.eventId); assert.equal(state.presenceEvent.seq, 1);
  assert.equal(state.presenceEvent.expiresAt - state.presenceEvent.receivedAt, 15000);
  assert.equal((await api('state', {}, owner.token)).presenceEvent, undefined);
  assert.equal((await api('state', {}, another.token)).presenceEvent, undefined);
  await api('presenceSensorRevoke', { deviceId: 'living-room-link2' }, owner.token);
  await assert.rejects(postReport(createReport(data), { endpoint, token: issued.token }), { status: 401 });
  assert.equal((await api('state', {}, frame.token)).presenceEvent, undefined);
});
