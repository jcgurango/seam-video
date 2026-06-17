// Audio spike: prove the ffmpeg-audio.ts filtergraph can be replaced by an
// offline Web Audio render in Node + mediabunny encode/mux. Mirrors every op
// that gnarly amix/atrim/afade/asetrate command does:
//   trim (offset/duration) · speed (playbackRate, pitch-shifted) ·
//   gain envelope (linearRamp) · crossfade (overlapping ramps) · mix (sum)
// then AAC-encode the result and mux it with a video track into ONE mp4 -
// no ffmpeg CLI, no melt.

import { writeFileSync } from "node:fs";
import { OfflineAudioContext, AudioBuffer } from "node-web-audio-api";
import { registerMediabunnyServer } from "@mediabunny/server";
import {
  Input, FilePathSource, ALL_FORMATS, AudioBufferSink,
  Output, Mp4OutputFormat, FilePathTarget,
  AudioBufferSource, VideoSampleSource, VideoSample, QUALITY_HIGH, QUALITY_LOW,
} from "mediabunny";

globalThis.AudioBuffer = AudioBuffer; // let mediabunny + node-web-audio-api share one class
registerMediabunnyServer();
const stage = (s) => console.log(`\n=== ${s} ===`);
const OUT_DUR = 3.0;

// ---------------------------------------------------------------- 1. Decode audio -> one AudioBuffer
stage("1. mediabunny decode audio (Node) -> PCM AudioBuffer");
const input = new Input({ source: new FilePathSource("input.mp4"), formats: ALL_FORMATS });
const atrack = await input.getPrimaryAudioTrack();
if (!atrack) throw new Error("no audio track in input.mp4");
console.log(`source audio: ${atrack.codec}, ${atrack.numberOfChannels}ch @ ${atrack.sampleRate}Hz`);

const sink = new AudioBufferSink(atrack);
const chunks = []; // per-channel Float32 chunks
let SR = atrack.sampleRate, CH = atrack.numberOfChannels, total = 0;
for await (const { buffer } of sink.buffers(0, 6)) { // first 6s is plenty
  SR = buffer.sampleRate; CH = buffer.numberOfChannels;
  const c = [];
  for (let ch = 0; ch < CH; ch++) c.push(Float32Array.from(buffer.getChannelData(ch)));
  chunks.push(c); total += buffer.length;
}
const srcBuf = new AudioBuffer({ length: total, numberOfChannels: CH, sampleRate: SR });
for (let ch = 0; ch < CH; ch++) {
  const out = srcBuf.getChannelData(ch); let off = 0;
  for (const c of chunks) { out.set(c[ch], off); off += c[ch].length; }
}
console.log(`decoded ${(total / SR).toFixed(2)}s of source audio`);

// ---------------------------------------------------------------- 2. Offline mix
stage("2. OfflineAudioContext: 2 clips, trim+speed+gain+crossfade+mix");
const ctx = new OfflineAudioContext(CH, Math.round(OUT_DUR * SR), SR);

// clip A: trim [0.5..3.0]s of source, full-rate, fade in 0->0.3s, fade OUT 2.0->3.0 (crossfade tail)
{
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, 0.3);
  g.gain.setValueAtTime(1, 2.0);
  g.gain.linearRampToValueAtTime(0, 3.0);  // crossfade out
  g.connect(ctx.destination);
  const s = ctx.createBufferSource();
  s.buffer = srcBuf; s.playbackRate.value = 1.0;
  s.connect(g);
  s.start(0, /*offset*/ 0.5, /*duration*/ 2.5);  // <- atrim
}
// clip B: trim [1.0..]s, SPEED 1.5x (pitch-shifted), starts at 2.0 overlapping A, fade IN 2.0->3.0
{
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 2.0);
  g.gain.linearRampToValueAtTime(1, 3.0);  // crossfade in (mirrors A's fade out)
  g.connect(ctx.destination);
  const s = ctx.createBufferSource();
  s.buffer = srcBuf; s.playbackRate.value = 1.5;  // <- asetrate speed/pitch
  s.connect(g);
  s.start(2.0, /*offset*/ 1.0, /*duration*/ 1.5);
}
const mix = await ctx.startRendering();   // <- amix (sum at destination)
console.log(`rendered mix: ${mix.numberOfChannels}ch ${mix.length} frames @ ${mix.sampleRate}Hz`);

// numeric witnesses: non-silent, not clipping, and both clips actually present
function rms(buf, t0, t1) {
  const a = buf.getChannelData(0); const i0 = (t0 * SR) | 0, i1 = (t1 * SR) | 0;
  let s = 0, peak = 0; for (let i = i0; i < i1; i++) { s += a[i] * a[i]; peak = Math.max(peak, Math.abs(a[i])); }
  return { rms: Math.sqrt(s / (i1 - i0)), peak };
}
const whole = rms(mix, 0, OUT_DUR), tail = rms(mix, 0, 0.05), xfade = rms(mix, 2.4, 2.6);
console.log(`RMS whole=${whole.rms.toFixed(4)} peak=${whole.peak.toFixed(3)} | startFadeIn RMS(0-50ms)=${tail.rms.toFixed(4)} | crossfade RMS(2.4-2.6s)=${xfade.rms.toFixed(4)}`);

// ---------------------------------------------------------------- 3. WAV witness (listenable)
stage("3. write mix.wav (listenable witness)");
writeFileSync("mix.wav", encodeWav(mix));
console.log("wrote mix.wav");

// ---------------------------------------------------------------- 4. Encode AAC + procedural video, mux into one mp4
stage("4. encode AAC + video, mux -> out-av.mp4 (single in-process Output)");
const VW = 320, VH = 180, FPS = 30, NF = Math.round(OUT_DUR * FPS);
const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget("out-av.mp4") });
const asrc = new AudioBufferSource({ codec: "aac", bitrate: QUALITY_HIGH });
const vsrc = new VideoSampleSource({ codec: "avc", bitrate: QUALITY_LOW });
output.addVideoTrack(vsrc, { frameRate: FPS });
output.addAudioTrack(asrc);
await output.start();

await asrc.add(mix); // whole mixed buffer in one shot

const px = new Uint8Array(VW * VH * 4);
for (let i = 0; i < NF; i++) {
  const hue = (i / NF) * 360, [r, g, b] = hsv(hue, 0.7, 0.9);
  for (let p = 0; p < VW * VH; p++) { px[p * 4] = r; px[p * 4 + 1] = g; px[p * 4 + 2] = b; px[p * 4 + 3] = 255; }
  const s = new VideoSample(px, { format: "RGBA", codedWidth: VW, codedHeight: VH, timestamp: i / FPS, duration: 1 / FPS });
  await vsrc.add(s); s.close();
}
await output.finalize();
console.log("wrote out-av.mp4");

// ---------------------------------------------------------------- helpers
function hsv(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255 | 0, (g + m) * 255 | 0, (b + m) * 255 | 0];
}
function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    let v = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
    data.writeInt16LE((v * 32767) | 0, (i * ch + c) * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(ch, 22); head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * ch * 2, 28);
  head.writeUInt16LE(ch * 2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

input.dispose?.();
console.log("\nDONE.");
process.exit(0);
