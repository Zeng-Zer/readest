// A mono 16-bit PCM WAV with a tone where `speech` says the voice is and
// silence elsewhere, for tests that read audio the way system TTS renders it.
export const SAMPLE_RATE = 24000;

export const wav = (seconds: number, speech: Array<[number, number]>): ArrayBuffer => {
  const n = Math.round(seconds * SAMPLE_RATE);
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);
  for (const [from, to] of speech) {
    for (let i = Math.round(from * SAMPLE_RATE); i < Math.round(to * SAMPLE_RATE); i++) {
      view.setInt16(44 + i * 2, Math.round(8000 * Math.sin(i / 5)), true);
    }
  }
  return buffer;
};
