'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const shell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const root = path.resolve(__dirname, '..');
const flags = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
async function ps(script, args = []) {
  const operation = execute(shell, [...flags, '-File', path.join(root, script), ...args], { windowsHide: true, timeout: 15000,
    env: { ...process.env, PRESENCE_SENSOR_TOKEN: '', PRESENCE_DEVICE_ID: '', PRESENCE_ENDPOINT: '' } });
  // PowerShell forwards redirected stdin to native commands; this noninteractive
  // configuration test has no input and must close its pipe explicitly.
  operation.child.stdin.end();
  return operation;
}
test('PowerShell launcher loads only the explicitly supplied config without displaying its token', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link2-launcher-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('link2-launcher-test-')); await fs.rm(dir, { recursive: true, force: true }); });
  const filename = path.join(dir, 'sensor.private.json'), token = ['ps1', crypto.randomUUID(), crypto.randomBytes(32).toString('hex')].join('.');
  await fs.writeFile(filename, JSON.stringify({ endpoint: 'http://127.0.0.1:1234/api', deviceId: 'launcher-fixture', sensorToken: token }));
  const args = ['-ConfigPath', filename, '-NodePath', process.execPath, '-CheckConfig'];
  const result = await ps('start-cloud-uploader.ps1', args);
  assert.match(result.stdout, /configuration valid/); assert.match(result.stdout, /launcher-fixture/);
  assert.ok(!(result.stdout + result.stderr).includes(token));
  await assert.rejects(ps('start-cloud-uploader.ps1', [...args, '-Endpoint', 'https://example.invalid/api?secret=' + token]), error => error.code === 1 && !(error.stdout + error.stderr).includes(token));
  await fs.writeFile(filename, '{"sensorToken":"' + token + '", BAD JSON');
  await assert.rejects(ps('start-cloud-uploader.ps1', args), error => error.code === 1 && !(error.stdout + error.stderr).includes(token));
});
test('Windows build preflight explains absent or invalid SDK without invoking any camera', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(ps('build.ps1'), error => /Provide exactly one/.test(error.stderr));
  await assert.rejects(ps('build.ps1', ['-SdkRoot', os.tmpdir()]), error => /x64\/include\/uvc_camera.h/.test(error.stderr));
});
test('PowerShell pipeline forwards one synthetic EVENT in stdin dry-run mode', { skip: process.platform !== 'win32' }, async () => {
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const command = "('EVENT:' + (@{type='presence.dwell';timestamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();dwellMs=4200;headCount=1} | ConvertTo-Json -Compress)) | & " +
    quote(path.join(root, 'start-cloud-uploader.ps1')) + ' -NodePath ' + quote(process.execPath) + ' -Stdin -Once -DryRun';
  const operation = execute(shell, [...flags, '-Command', command], { windowsHide: true, timeout: 15000,
    env: { ...process.env, PRESENCE_SENSOR_TOKEN: '', PRESENCE_DEVICE_ID: '', PRESENCE_ENDPOINT: '' } });
  operation.child.stdin.end();
  const result = await operation; assert.equal((result.stdout.match(/dry-run \{/g) || []).length, 1);
});
