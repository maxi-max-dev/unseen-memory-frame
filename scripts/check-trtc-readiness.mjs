#!/usr/bin/env node
import fs from 'node:fs/promises';
import { readiness, probeCloudbase } from '../server/ai-realtime-readiness.js';

// Default: pure local validation. No SDK, cloud resource, microphone or LLM call.
// Private values enter through --env-file or a private deployment configuration,
// never through command-line credentials. Output contains only fixed fields.
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node [--env-file=<private.env>] scripts/check-trtc-readiness.mjs [--config <private-cloudbaserc.json>] [--probe-llm]');
    console.log('Default is offline. --probe-llm makes ONE chargeable CloudBase hy3 streaming request; it does not start TRTC.');
  } else {
    let env = process.env, probe = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--probe-llm' && !probe) probe = true;
      else if (args[i] === '--config' && args[i + 1] && env === process.env) {
        const config = JSON.parse(await fs.readFile(args[++i], 'utf8'));
        const targets = config.functions?.filter(f => f.name === 'memory-frame-demo');
        if (targets?.length !== 1 || !targets[0].envVariables) throw Error('config');
        // Avoid silently combining credentials from two different environments.
        env = targets[0].envVariables;
      } else throw Error('arguments');
    }
    const report = readiness(env);
    if (probe) report.probe = await probeCloudbase(env);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = (probe ? !report.probe.ok : !report.configurationReady) ? 2 : 0;
  }
} catch {
  console.error(JSON.stringify({ ok: false, code: 'READINESS_INPUT_INVALID', hint: 'Check arguments and private configuration; no credentials are printed.' }));
  process.exitCode = 1;
}
