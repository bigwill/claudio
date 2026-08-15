/**
 * Minimal RIFF/WAVE reader so the analysis layer can be exercised in Node
 * against real files. The browser uses decodeAudioData; this exists purely
 * so we can validate the extractor without a browser.
 *
 * Handles PCM 8/16/24/32-bit and 32/64-bit float, any channel count.
 */

import { readFileSync } from "node:fs";

export interface DecodedWav {
  /** Interleaved-then-mono-summed is NOT done here — channels are kept separate. */
  channels: Float32Array[];
  sampleRate: number;
  durationSec: number;
}

export function decodeWavFile(path: string): DecodedWav {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let format = 1;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  // Walk the chunk list rather than assuming fmt-then-data at fixed offsets;
  // real-world files interleave LIST/fact/smpl chunks all over the place.
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      numChannels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE stores the real format in the subformat GUID.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      dataStart = body;
      dataLength = size;
    }

    pos = body + size + (size % 2); // chunks are word-aligned
  }

  if (dataStart < 0 || !numChannels || !sampleRate) {
    throw new Error(`${path}: missing fmt or data chunk`);
  }

  const bytesPerSample = bitsPerSample >> 3;
  const frameSize = bytesPerSample * numChannels;
  const frames = Math.floor(Math.min(dataLength, buf.length - dataStart) / frameSize);

  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numChannels; c++) {
      const o = dataStart + f * frameSize + c * bytesPerSample;
      let v = 0;
      if (format === 3) {
        v = bitsPerSample === 64 ? buf.readDoubleLE(o) : buf.readFloatLE(o);
      } else if (bitsPerSample === 8) {
        v = (buf.readUInt8(o) - 128) / 128; // 8-bit PCM is unsigned
      } else if (bitsPerSample === 16) {
        v = buf.readInt16LE(o) / 32768;
      } else if (bitsPerSample === 24) {
        const raw = buf.readUInt8(o) | (buf.readUInt8(o + 1) << 8) | (buf.readInt8(o + 2) << 16);
        v = raw / 8388608;
      } else if (bitsPerSample === 32) {
        v = buf.readInt32LE(o) / 2147483648;
      } else {
        throw new Error(`${path}: unsupported bit depth ${bitsPerSample}`);
      }
      channels[c][f] = v;
    }
  }

  return { channels, sampleRate, durationSec: frames / sampleRate };
}
