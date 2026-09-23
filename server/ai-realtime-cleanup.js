'use strict';
// Event-function entry for a future private Timer. Importing this module or
// invoking it with the default configuration performs no I/O.
const { CloudStore } = require('./store');
const { createTRTC } = require('./ai-realtime-trtc');
const { createRealtime } = require('./ai-realtime');
const TRIGGER = 'unseen-ai-realtime-cleanup';
function createCleanupHandler({ env = process.env, storeFactory = id => new CloudStore(id), providerFactory = createTRTC, report = () => {} } = {}) {
  return async event => {
    if (env.AI_REALTIME_CLEANUP_ENABLED !== '1') return { enabled: false, verification: 'not-run' };
    // This is an additional shape guard, not authentication. Deploy only as a
    // private event function with IAM-authorized Timer invocation, never HTTP.
    if (event?.Type !== 'Timer' || event.TriggerName !== TRIGGER) throw Error('Realtime cleanup requires the configured private Timer');
    if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(env.MEMORY_CLOUDBASE_ENV || '')) throw Error('Realtime cleanup environment is not configured');
    const provider = providerFactory({ env });
    if (!provider.cleanupReady()) throw Error('Realtime cleanup control credentials are not configured');
    try {
      const store = await storeFactory(env.MEMORY_CLOUDBASE_ENV);
      await store.init();
      const result = await createRealtime(store, { provider }).cleanupExpired({ stopAll: env.AI_REALTIME_CLEANUP_STOP_ALL === '1' });
      const summary = { enabled: true, ok: !result.errors && !result.pending && !result.deferred, ...result };
      report(summary); return summary;
    } catch { throw Error('Realtime cleanup failed; inspect private storage and provider access'); }
  };
}
module.exports = { createCleanupHandler, main: createCleanupHandler({
  report: summary => console.info('[ai-realtime-cleanup]', JSON.stringify(summary))
}), TRIGGER };
