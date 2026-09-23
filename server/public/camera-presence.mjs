// Opt-in local presence policy. Importing this module never opens a camera.
export const CAMERA_OBSERVATION_VERSION = 1;

const PRESENCE = new Set(['present', 'absent', 'unknown']);
const ATTENTION = new Set(['looking', 'away', 'unknown']);
const PRIVACY = new Set(['off', 'on', 'unknown']);

export function createCameraPresenceController({
  adapter,
  onGreet,
  onError = () => {},
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  dwellMs = 2000,
  cooldownMs = 60000,
  rearmAbsentMs = 5000,
  maxAgeMs = 1500,
  maxGapMs = 1000,
  requireGaze = false,
} = {}) {
  if (!adapter || typeof adapter.start !== 'function' || typeof adapter.stop !== 'function'
      || adapter.capabilities?.presence !== true || typeof onGreet !== 'function') {
    throw new TypeError('A presence adapter and onGreet callback are required');
  }
  for (const [name, value] of Object.entries({ dwellMs, cooldownMs, rearmAbsentMs, maxAgeMs, maxGapMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  }
  if (maxGapMs > maxAgeMs) throw new TypeError('maxGapMs must not exceed maxAgeMs');

  let enabled = false;
  let disposed = false;
  // The application must explicitly provide privacy consent and visible state.
  let context = { visible: false, busy: false, privacyAllowed: false };
  let run = null;
  let revision = 0;
  let work = Promise.resolve();
  let lastSampleAt = null;
  let lastAcceptedAt = null;
  let presentSince = null;
  let absentSince = null;
  let armed = true;
  let lastGreetAt = null;
  let greeting = null;
  let freshnessTimer = null;
  const capabilities = Object.freeze({
    presence: true,
    gaze: adapter.capabilities.gaze === true,
  });

  const report = (code) => { try { onError({ code }); } catch { /* consumer error isolation */ } };
  const canRun = () => enabled && !disposed && context.visible && !context.busy && context.privacyAllowed;
  const clearEvidence = () => { presentSince = null; absentSince = null; lastSampleAt = null; };
  const abortGreeting = () => {
    greeting?.abort(); greeting = null;
    if (freshnessTimer !== null) cancel(freshnessTimer);
    freshnessTimer = null;
  };

  function armFreshness() {
    if (freshnessTimer !== null) cancel(freshnessTimer);
    freshnessTimer = schedule(() => {
      freshnessTimer = null;
      if (lastAcceptedAt === null || now() - lastAcceptedAt > maxAgeMs) {
        clearEvidence(); abortGreeting();
      } else if (greeting) armFreshness();
    }, Math.max(1, maxAgeMs - (now() - lastAcceptedAt) + 1));
  }

  function observe(sample, session) {
    if (run !== session || session.abort.signal.aborted || !canRun()) return false;
    const at = now();
    const valid = sample?.version === CAMERA_OBSERVATION_VERSION
      && Number.isFinite(sample.observedAt) && sample.observedAt <= at
      && at - sample.observedAt <= maxAgeMs
      && (lastAcceptedAt === null || sample.observedAt > lastAcceptedAt)
      && PRESENCE.has(sample.presence) && ATTENTION.has(sample.attention) && PRIVACY.has(sample.privacy);
    if (!valid) { clearEvidence(); abortGreeting(); return false; }
    lastAcceptedAt = sample.observedAt;
    const continuous = lastSampleAt !== null && sample.observedAt - lastSampleAt <= maxGapMs;
    if (!continuous) clearEvidence();
    lastSampleAt = sample.observedAt;
    if (sample.privacy !== 'off' || sample.presence === 'unknown') {
      clearEvidence(); abortGreeting(); return false;
    }
    if (sample.presence === 'absent') {
      presentSince = null;
      abortGreeting();
      absentSince ??= sample.observedAt;
      if (sample.observedAt - absentSince >= rearmAbsentMs) armed = true;
      return false;
    }
    absentSince = null;
    if (requireGaze && (!capabilities.gaze || sample.attention !== 'looking')) {
      presentSince = null;
      abortGreeting();
      return false;
    }
    presentSince ??= sample.observedAt;
    if (greeting) armFreshness();
    if (!armed || greeting || sample.observedAt - presentSince < dwellMs
        || (lastGreetAt !== null && at - lastGreetAt < cooldownMs)) return false;

    // Consume this visit before calling the application, including failed greetings.
    armed = false;
    lastGreetAt = at;
    const invitation = new AbortController();
    greeting = invitation;
    armFreshness();
    const event = Object.freeze({
      reason: requireGaze ? 'attention' : 'presence',
      observedAt: sample.observedAt,
      signal: invitation.signal,
    });
    Promise.resolve().then(() => {
      if (now() - event.observedAt > maxAgeMs) { invitation.abort(); return; }
      if (!invitation.signal.aborted && canRun()) return onGreet(event);
    }).catch(() => {
      if (!invitation.signal.aborted) report('greeting-failed');
    });
    return true;
  }

  function transition() {
    const requested = ++revision;
    run?.abort.abort();
    abortGreeting();
    clearEvidence();
    work = work.then(async () => {
      if (run) {
        run = null;
        try { await adapter.stop(); } catch {
          enabled = false;
          report('adapter-stop-failed');
          return;
        }
      }
      if (requested !== revision || !canRun()) return;
      const session = { abort: new AbortController() };
      run = session;
      try {
        await adapter.start({
          signal: session.abort.signal,
          onObservation: (sample) => observe(sample, session),
          onError: (error) => {
            if (run !== session || session.abort.signal.aborted) return;
            if (error?.fatal === true) {
              enabled = false;
              // Never return this queued transition to adapter.start: an adapter
              // may await its error callback while this queue awaits start.
              void transition();
              report('adapter-stopped');
            } else {
              clearEvidence(); abortGreeting(); report('observation-unavailable');
            }
          },
        });
      } catch {
        if (run === session && !session.abort.signal.aborted) {
          enabled = false;
          session.abort.abort();
          run = null;
          clearEvidence();
          abortGreeting();
          try { await adapter.stop(); } catch { /* original failure wins */ }
          report('adapter-start-failed');
        }
      }
    });
    return work;
  }

  return Object.freeze({
    capabilities,
    enable({ consent = false } = {}) {
      if (disposed) return Promise.reject(new Error('Controller is disposed'));
      if (consent !== true) return Promise.reject(new Error('Explicit camera consent is required'));
      if (enabled) return work;
      enabled = true;
      return transition();
    },
    disable() { enabled = false; return transition(); },
    setContext(patch = {}) {
      const previous = canRun();
      for (const key of ['visible', 'busy', 'privacyAllowed']) {
        if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
      }
      for (const key of ['visible', 'busy', 'privacyAllowed']) {
        if (Object.hasOwn(patch, key)) {
          context[key] = patch[key];
        }
      }
      // A hidden page or revoked privacy approval needs a new explicit user
      // enable action. Restoring visibility must not wake a hardware camera.
      if (patch.visible === false || patch.privacyAllowed === false) enabled = false;
      return previous !== canRun() ? transition() : work;
    },
    getState() {
      return Object.freeze({ enabled, disposed, running: !!run && !run.abort.signal.aborted,
        armed, lastGreetAt, context: Object.freeze({ ...context }), requireGaze });
    },
    dispose() { disposed = true; enabled = false; return transition(); },
  });
}
