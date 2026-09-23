'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server/public/ai-voice.js'), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Browser API doubles exercise the actual module's ownership and conversion contract.
// The offline renderer is controlled by the test: these are not microphone/browser tests.
function fixture(options = {}) {
  const contexts = [], streams = [], offlineContexts = [], events = [], timers = new Map(), requests = [];
  let timerId = 0;
  function stream() {
    const tracks = [0, 1].map(index => ({
      readyState: 'live', stops: 0,
      stop() { this.stops++; this.readyState = 'ended'; events.push(`stop:${index}`); }
    }));
    const value = { getTracks: () => tracks, tracks };
    streams.push(value);
    return value;
  }
  function node(kind) {
    return {
      connections: [], disconnects: 0,
      connect(other) { this.connections.push(other); },
      disconnect() { this.disconnects++; this.connections = []; events.push(`disconnect:${kind}`); }
    };
  }
  class AudioContext {
    constructor() {
      this.sampleRate = options.sampleRate || 48000;
      this.destination = {};
      this.closes = 0;
      contexts.push(this);
      events.push('context:create');
    }
    resume() { events.push('context:resume'); return options.resume ? options.resume(this) : Promise.resolve(); }
    close() { this.closes++; events.push('context:close'); return Promise.resolve(); }
    createMediaStreamSource(input) { this.stream = input; return (this.source = node('source')); }
    createScriptProcessor(...args) { this.processorArgs = args; return (this.processor = node('processor')); }
    createGain() { this.silent = node('gain'); this.silent.gain = { value: 1 }; return this.silent; }
  }
  class OfflineAudioContext {
    constructor(channels, length, sampleRate) {
      Object.assign(this, { channels, length, sampleRate, destination: {} });
      offlineContexts.push(this);
      events.push('offline:create');
    }
    createBuffer(channels, length, sampleRate) {
      const samples = new Float32Array(length);
      this.input = { channels, length, sampleRate, samples, getChannelData: channel => {
        assert.equal(channel, 0);
        return samples;
      } };
      return this.input;
    }
    createBufferSource() {
      this.source = node('offline-source');
      this.source.starts = 0;
      this.source.start = () => { this.source.starts++; };
      return this.source;
    }
    startRendering() {
      events.push('offline:render');
      return options.render ? options.render(this) : Promise.resolve({ getChannelData: () => new Float32Array(this.length) });
    }
  }
  const context = vm.createContext({
    Blob, AudioContext,
    OfflineAudioContext: options.offline === false ? undefined : OfflineAudioContext,
    navigator: { mediaDevices: { getUserMedia: constraints => {
      requests.push(constraints);
      return options.getUserMedia ? options.getUserMedia() : Promise.resolve(stream());
    } } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context, { filename: 'ai-voice.js' });
  const recorder = context.MemoryVoice.create({ onTimeout: options.onTimeout || (() => {}) });
  function feed(samples, audioContext = contexts.at(-1)) {
    audioContext.processor.onaudioprocess({ inputBuffer: { getChannelData: channel => {
      assert.equal(channel, 0);
      return samples;
    } } });
  }
  function assertReleased(audioContext = contexts.at(-1)) {
    for (const track of audioContext.stream.tracks) assert.equal(track.readyState, 'ended');
    assert.equal(audioContext.closes, 1);
    for (const item of [audioContext.source, audioContext.processor, audioContext.silent]) {
      assert.equal(item.disconnects, 1);
      assert.equal(item.connections.length, 0);
    }
    assert.equal(audioContext.processor.onaudioprocess, null);
    assert.equal(timers.size, 0);
  }
  return { recorder, contexts, offlineContexts, streams, events, timers, requests, stream, feed, assertReleased };
}

test('cancel while microphone permission is pending stops a late stream without creating an audio context', async () => {
  const permission = deferred();
  const f = fixture({ getUserMedia: () => permission.promise });
  const starting = f.recorder.start();
  await f.recorder.start();
  assert.equal(f.requests.length, 1, 'a second click must not duplicate the pending microphone request');
  f.recorder.cancel();
  f.recorder.cancel();
  const lateStream = f.stream();
  permission.resolve(lateStream);
  assert.equal(await starting, false);
  for (const track of lateStream.tracks) assert.equal(track.stops, 1);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(await f.recorder.finish(), null);
});

test('a cancelled permission request cannot replace a newer recording', async () => {
  const permissions = [deferred(), deferred()];
  let request = 0;
  const f = fixture({ getUserMedia: () => permissions[request++].promise });
  const oldStart = f.recorder.start();
  f.recorder.cancel();
  const newStart = f.recorder.start();
  const currentStream = f.stream();
  permissions[1].resolve(currentStream);
  assert.equal(await newStart, true);
  const staleStream = f.stream();
  permissions[0].resolve(staleStream);
  assert.equal(await oldStart, false);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].stream, currentStream);
  assert.ok(currentStream.tracks.every(track => track.readyState === 'live'));
  assert.ok(staleStream.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.timers.size, 1);
  f.recorder.cancel();
  f.assertReleased();
});

test('AudioContext resume failure closes the context and every track, and allows retry', async () => {
  let fail = true;
  const f = fixture({ resume: () => fail ? Promise.reject(new Error('device unavailable')) : Promise.resolve() });
  await assert.rejects(f.recorder.start(), /无法开始录音/);
  assert.ok(f.streams[0].tracks.every(track => track.stops === 1));
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.contexts[0].processor, undefined);
  assert.equal(f.timers.size, 0);
  f.recorder.cancel();
  assert.equal(f.contexts[0].closes, 1);
  fail = false;
  assert.equal(await f.recorder.start(), true);
  f.recorder.cancel();
  f.assertReleased();
});

test('permission denial is reported accurately without allocating audio resources', async () => {
  const denial = new Error('denied'); denial.name = 'NotAllowedError';
  const f = fixture({ getUserMedia: () => Promise.reject(denial) });
  await assert.rejects(f.recorder.start(), /麦克风未获允许/);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.timers.size, 0);
  f.recorder.cancel();
  assert.equal(await f.recorder.finish(), null);
});

test('finish releases microphone and capture graph before rendering, and cancellation invalidates a late render', async () => {
  const rendering = deferred();
  const f = fixture({ render: () => rendering.promise });
  await f.recorder.start();
  f.feed(new Float32Array(4800).fill(0.25));
  const finishing = f.recorder.finish();
  f.assertReleased();
  const renderAt = f.events.indexOf('offline:render');
  assert.ok(renderAt > f.events.indexOf('context:close'));
  assert.ok(renderAt > f.events.indexOf('stop:0'));
  assert.ok(renderAt > f.events.indexOf('stop:1'));
  assert.equal(await f.recorder.finish(), null);
  f.recorder.cancel();
  f.recorder.cancel();
  rendering.resolve({ getChannelData: () => new Float32Array(1600).fill(0.5) });
  assert.equal(await finishing, null, 'cancelled voice must never be sent as a late result');
  f.assertReleased();
});

test('conversion passes copied mono chunks to a 16 kHz renderer and writes a clipped PCM16 WAV', async () => {
  const output = new Float32Array(3200);
  output.set([-2, -1, -0.5, 0, 0.5, 1, 2]);
  const f = fixture({ render: () => Promise.resolve({ getChannelData: channel => {
    assert.equal(channel, 0);
    return output;
  } }) });
  await f.recorder.start();
  const first = new Float32Array(4800).fill(0.25), second = new Float32Array(4800).fill(-0.25);
  f.feed(first); f.feed(second);
  first.fill(0); second.fill(0); // Browser input buffers can be reused after the callback.
  const wav = await f.recorder.finish();
  f.assertReleased();
  const offline = f.offlineContexts[0];
  assert.deepEqual([offline.channels, offline.length, offline.sampleRate], [1, 3200, 16000]);
  assert.deepEqual([offline.input.channels, offline.input.length, offline.input.sampleRate], [1, 9600, 48000]);
  assert.equal(offline.input.samples[0], 0.25);
  assert.equal(offline.input.samples[4799], 0.25);
  assert.equal(offline.input.samples[4800], -0.25);
  assert.equal(offline.input.samples[9599], -0.25);
  assert.equal(offline.source.buffer, offline.input);
  assert.equal(offline.source.starts, 1);
  assert.equal(wav.type, 'audio/wav');
  const bytes = Buffer.from(await wav.arrayBuffer());
  assert.equal(bytes.length, 44 + output.length * 2);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(bytes.readUInt32LE(16), 16);
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt32LE(28), 32000);
  assert.equal(bytes.readUInt16LE(32), 2);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  assert.equal(bytes.readUInt32LE(40), output.length * 2);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => bytes.readInt16LE(44 + i * 2)), [-32768, -32768, -16384, 0, 16383, 32767, 32767]);
});

test('too-short audio, unavailable conversion, and renderer rejection all leave capture resources released', async () => {
  for (const scenario of [
    { options: {}, samples: 4797, error: /录音太短/ },
    { options: { offline: false }, samples: 4800, error: /不支持录音转换/ },
    { options: { render: () => Promise.reject(new Error('renderer failed')) }, samples: 4800, error: /renderer failed/ }
  ]) {
    const f = fixture(scenario.options);
    await f.recorder.start();
    f.feed(new Float32Array(scenario.samples));
    await assert.rejects(f.recorder.finish(), scenario.error);
    f.assertReleased();
    f.recorder.cancel();
    f.assertReleased();
    assert.equal(await f.recorder.finish(), null);
  }
});

test('repeated start/cancel cycles release the timer, all nodes and all tracks exactly once', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    assert.equal(await f.recorder.start(), true);
    await f.recorder.start();
    const audioContext = f.contexts.at(-1);
    assert.equal(f.requests.length, i + 1);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].ms, 60000);
    assert.equal(audioContext.silent.gain.value, 0, 'capture must not feed audible microphone audio back to the speakers');
    const lateCallback = audioContext.processor.onaudioprocess;
    f.recorder.cancel(); f.recorder.cancel(); f.recorder.cancel();
    f.assertReleased(audioContext);
    assert.ok(audioContext.stream.tracks.every(track => track.stops === 1));
    lateCallback({ inputBuffer: { getChannelData() { assert.fail('a stale callback must not read or retain microphone samples'); } } });
    assert.equal(await f.recorder.finish(), null);
  }
  assert.equal(f.offlineContexts.length, 0);
});
