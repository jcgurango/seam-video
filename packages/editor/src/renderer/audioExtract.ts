// Extract a mono PCM-16 WAV blob from an audio source's [in, out] range,
// using mediabunny to decode. Used by the transcription job to feed the
// generator server only the audio it needs.
//
// The decode half (`decodeMonoRange`) and the WAV encoder (`encodeWavMono16`)
// are also reused by the composition audio mixer (`compositionAudioMix.ts`),
// which schedules many such ranges into one OfflineAudioContext mix.

import { Input, UrlSource, BlobSource, ALL_FORMATS, AudioBufferSink } from "mediabunny";

/** Mono float PCM decoded from a source's [startSec, endSec] range. */
export interface MonoRange {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Decode a source file's [startSec, endSec] range to mono Float32 PCM at the
 * source's native sample rate. Throws if the source has no decodable audio or
 * the range yields no samples.
 */
export async function decodeMonoRange(
  sourceUrl: string,
  startSec: number,
  endSec: number
): Promise<MonoRange> {
  if (!(endSec > startSec)) {
    throw new Error(`decodeMonoRange: invalid range (in=${startSec}, out=${endSec})`);
  }

  const input = await openInput(sourceUrl);
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      throw new Error(`No audio track in ${sourceUrl}`);
    }
    if (!(await audioTrack.canDecode())) {
      throw new Error(`Audio track in ${sourceUrl} is not decodable in this browser`);
    }

    const sink = new AudioBufferSink(audioTrack);
    const samples: Float32Array[] = [];
    let sampleRate: number | null = null;

    for await (const wrapped of sink.buffers(startSec, endSec)) {
      const buf = wrapped.buffer;
      sampleRate = sampleRate ?? buf.sampleRate;

      // Mediabunny gives us buffers that overlap the request, not exactly
      // clipped. Trim each buffer to the [startSec, endSec] window.
      const bufStart = wrapped.timestamp;
      const bufEnd = bufStart + wrapped.duration;
      const visStart = Math.max(bufStart, startSec);
      const visEnd = Math.min(bufEnd, endSec);
      if (visEnd <= visStart) continue;

      const startSample = Math.max(0, Math.floor((visStart - bufStart) * buf.sampleRate));
      const endSample = Math.min(
        buf.length,
        Math.floor((visEnd - bufStart) * buf.sampleRate)
      );
      const len = endSample - startSample;
      if (len <= 0) continue;

      // Downmix to mono. Whisper has no use for stereo, and dropping a
      // channel halves the upload size for stereo sources.
      const mono = new Float32Array(len);
      const channels = buf.numberOfChannels;
      if (channels === 1) {
        mono.set(buf.getChannelData(0).subarray(startSample, endSample));
      } else {
        for (let c = 0; c < channels; c++) {
          const ch = buf.getChannelData(c);
          for (let i = 0; i < len; i++) {
            mono[i] += ch[startSample + i];
          }
        }
        const inv = 1 / channels;
        for (let i = 0; i < len; i++) mono[i] *= inv;
      }
      samples.push(mono);
    }

    if (sampleRate == null || samples.length === 0) {
      throw new Error(
        `No audio samples in ${sourceUrl} between ${startSec}s and ${endSec}s`
      );
    }

    const total = samples.reduce((s, a) => s + a.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const a of samples) {
      all.set(a, off);
      off += a.length;
    }
    return { samples: all, sampleRate };
  } finally {
    // mediabunny's Input has no explicit close() — let GC handle it. The
    // try/finally is here for symmetry with the resource lifetime so that
    // if we add cleanup later it has a home.
    void input;
  }
}

export async function extractAudioWav(
  sourceUrl: string,
  startSec: number,
  endSec: number
): Promise<Blob> {
  const { samples, sampleRate } = await decodeMonoRange(sourceUrl, startSec, endSec);
  return encodeWavMono16(samples, sampleRate);
}

async function openInput(sourceUrl: string): Promise<Input> {
  try {
    return new Input({ source: new UrlSource(sourceUrl), formats: ALL_FORMATS });
  } catch {
    // Fallback for file:// URLs that UrlSource can't fetch directly: pull
    // it as a blob first. (Mirror of MediaStore.createInput.)
    const res = await fetch(sourceUrl);
    const blob = await res.blob();
    return new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  }
}

/** Encode a mono Float32 [-1, 1] PCM stream as a 16-bit RIFF/WAV blob. */
export function encodeWavMono16(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const dataBytes = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}
