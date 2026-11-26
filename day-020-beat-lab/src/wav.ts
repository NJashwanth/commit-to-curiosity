// A 16-bit PCM WAV encoder: a 44-byte RIFF header followed by interleaved
// little-endian samples. Samples are clamped, so a hot mix clips instead of wrapping.

/** Float sample (-1..1) to a signed 16-bit integer, clamped. NaN becomes silence. */
export function floatToInt16(s: number): number {
  if (Number.isNaN(s)) return 0;
  const c = s < -1 ? -1 : s > 1 ? 1 : s;
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff);
}

export const WAV_HEADER_BYTES = 44;

export function encodeWav(channels: ArrayLike<number>[], sampleRate: number): Uint8Array<ArrayBuffer> {
  if (channels.length < 1) throw new Error("A WAV needs at least one channel");
  const frames = channels[0].length;
  if (channels.some((c) => c.length !== frames)) throw new Error("All channels must have the same length");
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("Sample rate must be a positive integer");

  const nch = channels.length;
  const blockAlign = nch * 2;
  const dataBytes = frames * blockAlign;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));

  tag(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true); // file size minus the 8 bytes of "RIFF" + this field
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true); // byte rate
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true); // bits per sample
  tag(36, "data");
  v.setUint32(40, dataBytes, true);

  let p = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      v.setInt16(p, floatToInt16(channels[c][i]), true);
      p += 2;
    }
  }
  return out;
}
