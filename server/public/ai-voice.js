'use strict';
// Dedicated, disposable microphone capture; never uses the family's saved voice draft.
globalThis.MemoryVoice = (() => {
  function encode(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buffer);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, buffer.byteLength - 8, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * (s < 0 ? 32768 : 32767), true));
    return new Blob([buffer], { type: 'audio/wav' });
  }
  function create({ onTimeout = () => {} } = {}) {
    let generation = 0, rec = null, pending = false;
    function release(r) {
      if (!r) return;
      clearTimeout(r.timer);
      if (r.processor) r.processor.onaudioprocess = null;
      for (const node of [r.source, r.processor, r.silent]) { try { node?.disconnect(); } catch {} }
      r.stream?.getTracks().forEach(t => t.stop());
      r.context?.close().catch(() => {});
    }
    function cancel() { generation++; pending = false; const old = rec; rec = null; release(old); }
    async function start() {
      if (rec || pending) return;
      if (!navigator.mediaDevices?.getUserMedia || !(globalThis.AudioContext || globalThis.webkitAudioContext)) throw Error('此浏览器无法录音，请使用 HTTPS 页面并允许麦克风');
      const version = ++generation; pending = true;
      let local;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
        local = { stream, chunks: [], samples: 0 };
        if (version !== generation) { release(local); return false; }
        rec = local;
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        local.context = new Context(); await local.context.resume();
        if (version !== generation) { release(local); return false; }
        local.source = local.context.createMediaStreamSource(stream);
        local.processor = local.context.createScriptProcessor(4096, 1, 1); local.silent = local.context.createGain(); local.silent.gain.value = 0;
        local.processor.onaudioprocess = event => {
          if (rec !== local) return;
          const input = event.inputBuffer.getChannelData(0), remaining = Math.floor(local.context.sampleRate * 60) - local.samples;
          if (remaining > 0) { const chunk = new Float32Array(input.subarray(0, remaining)); local.chunks.push(chunk); local.samples += chunk.length; }
        };
        local.source.connect(local.processor); local.processor.connect(local.silent); local.silent.connect(local.context.destination);
        local.timer = setTimeout(onTimeout, 60000); return true;
      } catch (e) {
        if (rec === local) rec = null; release(local);
        if (version !== generation) return false;
        throw Error(e.name === 'NotAllowedError' ? '麦克风未获允许，请在浏览器设置中开启后重试' : '无法开始录音，请检查麦克风');
      } finally { if (version === generation) pending = false; }
    }
    async function finish() {
      const old = rec, version = generation; rec = null;
      if (!old) return null;
      // Stop tracks before asynchronous resampling; cancellation still invalidates the result.
      release(old);
      const length = Math.min(960000, Math.floor(old.samples / old.context.sampleRate * 16000));
      if (length < 1600) throw Error('录音太短，请再说一段');
      const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!Offline) throw Error('此浏览器暂不支持录音转换，可直接输入文字');
      const offline = new Offline(1, length, 16000), input = offline.createBuffer(1, old.samples, old.context.sampleRate);
      let offset = 0; for (const chunk of old.chunks) { input.getChannelData(0).set(chunk, offset); offset += chunk.length; }
      const source = offline.createBufferSource(); source.buffer = input; source.connect(offline.destination); source.start();
      const result = await offline.startRendering();
      return version === generation ? encode(result.getChannelData(0)) : null;
    }
    return { start, finish, cancel };
  }
  return { create };
})();
