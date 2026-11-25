// Frame-exact MP4 export in the browser (WebCodecs + mp4-muxer). Every frame is rendered at its exact time
// and encoded, so the result doesn't depend on how fast the viewer's computer is, unlike real-time recording.
// Music is mixed offline with the same 1.6 s fade-out as tools/produce_video.py.

const VIDEO_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];   // H.264 High, Main, Baseline (level 4.0)
const AUDIO_RATE = 48000;

export function canExportMp4() {
  return !!(window.VideoEncoder && window.VideoFrame && window.Mp4Muxer);
}

async function pickVideoConfig(width, height, fps) {
  for (const codec of VIDEO_CODECS) {
    const config = { codec, width, height, bitrate: 16_000_000, framerate: fps, latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return config; } catch {}
  }
  return null;
}

async function pickAudioConfig(channels) {
  if (!window.AudioEncoder) return null;
  for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate: AUDIO_RATE, numberOfChannels: channels, bitrate: 192_000 };
    try { if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxCodec }; } catch {}
  }
  return null;
}

async function mixMusic(buffer, seconds) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const ctx = new OfflineAudioContext(channels, Math.ceil(seconds * AUDIO_RATE), AUDIO_RATE);
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(1, Math.max(0, seconds - 1.6));
  gain.gain.linearRampToValueAtTime(0, seconds);
  src.connect(gain); gain.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

// mr: a prepared MotionRenderer with media.live = false; screen: full-size canvas it draws into.
export async function exportMp4({ mr, screen, music, onProgress = () => {} }) {
  const { width, height } = screen;
  const fps = mr.fps;
  const frames = Math.round(mr.tl.total * fps);
  const vConfig = await pickVideoConfig(width, height, fps);
  if (!vConfig) throw new Error('This browser cannot encode H.264 video.');
  const mixed = music ? await mixMusic(music, frames / fps) : null;
  const aPick = mixed ? await pickAudioConfig(mixed.numberOfChannels) : null;

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    ...(aPick ? { audio: { codec: aPick.muxCodec, sampleRate: AUDIO_RATE, numberOfChannels: mixed.numberOfChannels } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let failure = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { failure = e; } });
  venc.configure(vConfig);

  for (let i = 0; i < frames; i++) {
    if (failure) throw failure;
    await mr.frameAt(Math.min(i / fps, mr.tl.total - 1e-3), screen);
    const frame = new VideoFrame(screen, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 4));
    if (i % 6 === 0) onProgress(i / frames);
  }
  await venc.flush();

  if (aPick) {
    // Safari's AAC encoder reports a wrong AudioSpecificConfig; we asked for AAC-LC at 48 kHz, so write it ourselves
    const asc = new Uint8Array([0x11, 0x80 | (mixed.numberOfChannels << 3)]);
    const fixMeta = m => (aPick.muxCodec === 'aac' && m?.decoderConfig
      ? { ...m, decoderConfig: { ...m.decoderConfig, description: asc, sampleRate: AUDIO_RATE, numberOfChannels: mixed.numberOfChannels } } : m);
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, fixMeta(m)), error: e => { failure = e; } });
    aenc.configure(aPick.config);
    const ch = mixed.numberOfChannels, block = 4800;
    const planes = Array.from({ length: ch }, (_, k) => mixed.getChannelData(k));
    for (let s = 0; s < mixed.length; s += block) {
      const n = Math.min(block, mixed.length - s);
      const data = new Float32Array(n * ch);
      for (let k = 0; k < ch; k++) data.set(planes[k].subarray(s, s + n), k * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((s * 1e6) / AUDIO_RATE), data });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush();
  }
  if (failure) throw failure;
  muxer.finalize();
  onProgress(1);
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), audio: aPick?.muxCodec || (music ? 'none (browser cannot encode audio)' : 'none'), codec: vConfig.codec };
}
