import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2); let env, update = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env' && !env && args[i + 1]) env = args[++i];
  else if (args[i] === '--update' && !update) update = true;
  else throw Error('Usage: node scripts/deploy.mjs --env YOUR_ACTUAL_ENV_ID [--update]');
}
const configPath = path.join(root, 'cloudbaserc.local.json');
if (!env || !existsSync(configPath)) throw Error('Prepare your ignored cloudbaserc.local.json and explicitly provide --env.');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (env !== config.envId || /YOUR|REPLACE|EXAMPLE/i.test(env)) throw Error('Explicit environment must match your completed private configuration.');
if (!Array.isArray(config.functions) || config.functions.length !== 1) throw Error('Exactly one application function is supported.');
const fn = config.functions[0];
if (fn.envVariables?.MEMORY_CLOUDBASE_ENV !== env || fn.dir !== './server' || !fn.role || /YOUR|REPLACE|EXAMPLE/i.test(fn.role)) throw Error('Complete the application directory, environment and execution role.');
if (typeof fn.envVariables?.DEMO_SETUP_CODE !== 'string' || fn.envVariables.DEMO_SETUP_CODE.length < 16 || /YOUR|REPLACE|EXAMPLE/i.test(fn.envVariables.DEMO_SETUP_CODE)) throw Error('Use a private random setup code with at least 16 characters.');
if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,59}$/.test(fn.name)) throw Error('Invalid application function name.');
if (fn.envVariables.AI_REALTIME_ENABLED === '1' && !existsSync(path.join(root, 'server/public/vendor/trtc-5.19.2.mjs'))) throw Error('Prepare the optional TRTC module before enabling realtime.');
const cli = path.join(root, 'node_modules/@cloudbase/cli/bin/tcb');
const command = ['fn', 'deploy', fn.name, '--httpFn', '--path', '/', '--config-file', configPath];
if (update) command.push('--force');
console.log('Deploying the explicitly selected private configuration. No credentials are printed by this wrapper.');
const result = spawnSync(process.execPath, [cli, ...command], { cwd: root, stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
