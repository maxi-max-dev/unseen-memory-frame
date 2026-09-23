import { CAMERA_OBSERVATION_VERSION } from './camera-presence.mjs';

const unknown = (observedAt, privacy = 'unknown') => ({
  version: CAMERA_OBSERVATION_VERSION, observedAt, presence: 'unknown', attention: 'unknown', privacy,
});
const aborted = () => Object.assign(new Error('Camera start cancelled'), { name: 'AbortError' });
const stopStream = (stream) => { for (const track of stream?.getTracks?.() || []) track.stop(); };

// The native host owns SDK loading and device selection. No SDK or native bridge is
// bundled here. SDK return codes MUST be checked by those injected functions.
export function createLinkSdkPresenceAdapter({
  readPrivacy,
  readFaces,
  now = Date.now,
  intervalMs = 250,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (typeof readPrivacy !== 'function' || typeof readFaces !== 'function') {
    throw new TypeError('Native readPrivacy and readFaces functions are required');
  }
  return pollingAdapter({
    capabilities: { presence: true, gaze: false, evidence: 'link-sdk-face-boxes' },
    now, intervalMs, schedule, cancel,
    async read({ signal }) {
      const observedAt = now();
      const privacy = await readPrivacy({ signal });
      if (signal.aborted) throw aborted();
      if (privacy !== 'off') return unknown(observedAt, privacy === 'on' ? 'on' : 'unknown');
      const faces = await readFaces({ signal });
      if (signal.aborted) throw aborted();
      // GetTrackObjLists documents at most 10 UVCRect entries. Never reinterpret
      // an SDK error/unsupported result as an empty array (a verified absence).
      if (!Array.isArray(faces) || faces.length > 10) throw new Error('Invalid SDK face result');
      const finalPrivacy = await readPrivacy({ signal });
      if (finalPrivacy !== 'off') return unknown(observedAt, finalPrivacy === 'on' ? 'on' : 'unknown');
      return { ...unknown(observedAt, 'off'), presence: faces.length ? 'present' : 'absent' };
    },
  });
}

// No detector is provided. The future detector must run locally, must not retain
// frames, and must explicitly declare gaze support. No audio track is requested.
export function createBrowserCameraAdapter({
  detector,
  deviceId,
  getUserMedia = (constraints) => globalThis.navigator.mediaDevices.getUserMedia(constraints),
  createVideo = () => globalThis.document.createElement('video'),
  now = Date.now,
  intervalMs = 250,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (typeof detector?.detect !== 'function' || detector.capabilities?.presence !== true) {
    throw new TypeError('An explicitly supplied local presence detector is required');
  }
  const supportsGaze = detector.capabilities.gaze === true;
  let stream = null;
  let video = null;
  let removeTrackListeners = () => {};
  const release = () => {
    removeTrackListeners();
    removeTrackListeners = () => {};
    stopStream(stream);
    stream = null;
    if (video) { video.pause(); video.srcObject = null; video = null; }
  };
  return pollingAdapter({
    capabilities: { presence: true, gaze: supportsGaze, evidence: 'local-browser-detector' },
    now, intervalMs, schedule, cancel,
    async prepare({ signal, fail }) {
      const acquired = await getUserMedia({
        audio: false,
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 5, max: 10 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
      if (signal.aborted) { stopStream(acquired); throw aborted(); }
      stream = acquired;
      const tracks = stream.getVideoTracks();
      if (!tracks.length || tracks.some((track) => track.readyState !== 'live')) throw new Error('Camera unavailable');
      for (const track of tracks) track.addEventListener('ended', fail);
      removeTrackListeners = () => { for (const track of tracks) track.removeEventListener('ended', fail); };
      video = createVideo();
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (signal.aborted) throw aborted();
    },
    release,
    async read({ signal }) {
      const observedAt = now();
      if (!video || stream.getVideoTracks().some((track) => track.readyState !== 'live' || !track.enabled || track.muted)) {
        return unknown(observedAt);
      }
      const result = await detector.detect(video, { signal });
      if (signal.aborted) throw aborted();
      if (stream.getVideoTracks().some((track) => track.readyState !== 'live' || !track.enabled || track.muted)) {
        return unknown(observedAt);
      }
      if (!result || !['present', 'absent', 'unknown'].includes(result.presence)
          || !['looking', 'away', 'unknown'].includes(result.attention)) throw new Error('Invalid local detector result');
      return { ...unknown(observedAt, 'off'), presence: result.presence,
        attention: supportsGaze ? result.attention : 'unknown' };
    },
  });
}

function pollingAdapter({ capabilities, read, prepare, release = () => {}, now, intervalMs, schedule, cancel }) {
  if (!Number.isFinite(intervalMs) || intervalMs < 50) throw new TypeError('intervalMs must be at least 50');
  let session = null;
  const stop = () => {
    const previous = session;
    session = null;
    if (!previous) return;
    previous.abort.abort();
    if (previous.timer !== null) cancel(previous.timer);
    previous.removeAbort();
    release();
  };
  return Object.freeze({
    capabilities: Object.freeze({ ...capabilities }),
    async start({ signal, onObservation, onError = () => {} }) {
      if (session) throw new Error('Camera adapter already started');
      if (!signal || typeof onObservation !== 'function') throw new TypeError('Signal and observation callback required');
      if (signal.aborted) throw aborted();
      const current = { abort: new AbortController(), timer: null, removeAbort: () => {} };
      session = current;
      const active = () => session === current && !current.abort.signal.aborted;
      const unavailable = (fatal = false) => {
        if (!active()) return;
        onObservation(unknown(now()));
        onError({ code: fatal ? 'adapter-stopped' : 'observation-unavailable', fatal });
      };
      const externalAbort = () => { if (session === current) stop(); };
      signal.addEventListener('abort', externalAbort, { once: true });
      current.removeAbort = () => signal.removeEventListener('abort', externalAbort);
      try {
        await prepare?.({ signal: current.abort.signal, fail: () => {
          try { unavailable(true); } finally { if (active()) stop(); }
        } });
        if (!active()) throw aborted();
        const poll = async () => {
          if (!active()) return;
          current.timer = null;
          try {
            const sample = await read({ signal: current.abort.signal });
            if (active()) onObservation(sample);
          } catch { unavailable(); }
          if (active()) current.timer = schedule(poll, intervalMs);
        };
        // Returning from start means initialized; the first read is still async.
        void poll();
      } catch (error) {
        if (session === current) stop();
        throw error;
      }
    },
    stop,
  });
}
