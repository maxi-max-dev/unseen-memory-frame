'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
let sdk;
try { sdk = require('@cloudbase/node-sdk'); } catch { try { sdk = require('../server/node_modules/@cloudbase/node-sdk'); } catch {} }
test('actual CloudBase SDK serializes CAS predicates and returns updated count (network stubbed)', { skip: !sdk }, async () => {
  const db = sdk.init({ env: 'offline-contract-check' }).database();
  const query = db.collection('memory_demo_records').where({ _id: 'message', _rev: db.command.exists(false) });
  query._request.send = async (action, params) => {
    assert.equal(action, 'database.modifyDocument');
    const encoded = JSON.stringify(params);
    assert.match(encoded, /\$exists/); assert.match(encoded, /message/); assert.match(encoded, /_rev/);
    return { data: { updated: 1 }, requestId: 'offline' };
  };
  assert.equal((await query.update({ _rev: 1, aiLease: 'lease', card: { confirmed: true } })).updated, 1);
});
