// Word timings for engines that report none (Android system voices rendered
// to WAV), estimated from the rendered audio and the sentence text. Silences
// in the audio pin the phrase breaks the punctuation implies; the words of a
// phrase share its stretch of speech in proportion to their length, with the
// last one drawn out the way speech slows before a pause. Exact at every
// pause, it can run about a word early or late inside a long phrase. Checked
// against Whisper word timings on Supertonic and Kokoro audio: the highlight
// sits within a word of the voice 86-100% of the time.

import type { TTSWordBoundary } from '@/libs/edgeTTS';

const TICKS_PER_SECOND = 10_000_000;
const FRAME_SEC = 0.01;
// A frame this far below the loudest one is silence.
const SILENCE_RATIO = 10 ** (-35 / 20);
// Shorter gaps are the closures inside words, not pauses between them. At
// rate 1.0; a voice rendered faster pauses proportionally shorter.
const MIN_PAUSE_SEC = 0.12;
// How much longer the last word of a phrase lasts than its length suggests.
const PHRASE_FINAL_STRETCH = 2.2;
// Words, keeping inner apostrophes and hyphens ("Rabbit's", "daisy-chain").
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
// Punctuation between two words that a voice pauses at.
const BREAK_RE = /[,;:.!?…—–()]/;

interface Interval {
  start: number;
  end: number;
}

// Mono PCM16 samples of a WAV, or null for any other layout.
export const parseWav = (wav: ArrayBuffer): { samples: Int16Array; sampleRate: number } | null => {
  const view = new DataView(wav);
  if (wav.byteLength < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) {
    return null; // not RIFF/WAVE
  }
  let sampleRate = 0;
  let pcm16Mono = false;
  for (let pos = 12; pos + 8 <= wav.byteLength; ) {
    const id = view.getUint32(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420 /* 'fmt ' */) {
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      pcm16Mono = format === 1 && channels === 1 && view.getUint16(body + 14, true) === 16;
    } else if (id === 0x64617461 /* 'data' */) {
      if (!pcm16Mono || !sampleRate) return null;
      const length = Math.min(size, wav.byteLength - body) >> 1;
      return { samples: new Int16Array(wav.slice(body, body + length * 2)), sampleRate };
    }
    pos = body + size + (size & 1);
  }
  return null;
};

// Speech intervals of the audio, split wherever it falls silent for a pause.
const findSpeech = (samples: Int16Array, sampleRate: number, minPauseSec: number): Interval[] => {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const levels: number[] = [];
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(samples.length, i + frame);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    levels.push(Math.sqrt(sum / (end - i)));
  }
  const threshold = Math.max(...levels, 0) * SILENCE_RATIO;
  const minPauseFrames = Math.max(2, Math.round(minPauseSec / FRAME_SEC));
  const speech: Interval[] = [];
  let start = -1;
  let silent = 0;
  levels.forEach((level, i) => {
    if (level > threshold) {
      if (start < 0) start = i;
      else if (silent >= minPauseFrames) {
        speech.push({ start: start * FRAME_SEC, end: (i - silent) * FRAME_SEC });
        start = i;
      }
      silent = 0;
    } else if (start >= 0) {
      silent++;
    }
  });
  if (start >= 0)
    speech.push({ start: start * FRAME_SEC, end: (levels.length - silent) * FRAME_SEC });
  return speech;
};

// Clock time of a point `at` seconds into the concatenated speech intervals.
const clockAt = (speech: Interval[], at: number): number => {
  let left = at;
  for (const { start, end } of speech) {
    if (left <= end - start) return start + left;
    left -= end - start;
  }
  return speech[speech.length - 1]!.end;
};

const spoken = (speech: Interval[]) => speech.reduce((sum, s) => sum + s.end - s.start, 0);

/**
 * Estimated word boundaries for `text` spoken in `wav`, in the Edge wire
 * shape (100ns ticks from the start of the audio), scaled by `mediaRate` so
 * they are in the rate-1.0 media time the player reports. Empty when the
 * audio can't be read or has no speech: the caller falls back to sentence
 * highlighting.
 */
export const estimateWordBoundaries = (
  text: string,
  wav: ArrayBuffer,
  mediaRate = 1,
): TTSWordBoundary[] => {
  const audio = parseWav(wav);
  const words = [...text.matchAll(WORD_RE)];
  if (!audio || words.length === 0) return [];
  const speech = findSpeech(audio.samples, audio.sampleRate, MIN_PAUSE_SEC / mediaRate);
  if (speech.length === 0) return [];

  const weights = words.map((w) => w[0].length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  const totalSpeech = spoken(speech);

  // Phrases end at punctuation; each break claims the pause nearest to where
  // a uniform reading would put it, in order, so a missing or extra pause
  // only blurs the phrases around it.
  const segments: Array<{ from: number; to: number; speech: Interval[] }> = [];
  let firstWord = 0;
  let firstInterval = 0;
  let weightSoFar = 0;
  for (let i = 0; i < words.length; i++) {
    weightSoFar += weights[i]!;
    const next = words[i + 1];
    const gap = next ? text.slice(words[i]!.index! + words[i]![0].length, next.index) : '';
    if (next && !BREAK_RE.test(gap)) continue;
    let lastInterval = speech.length - 1;
    if (next) {
      const expected = (weightSoFar / total) * totalSpeech;
      let best = -1;
      let bestDistance = Infinity;
      let elapsed = 0;
      for (let k = firstInterval; k < speech.length - 1; k++) {
        elapsed = spoken(speech.slice(0, k + 1));
        const distance = Math.abs(elapsed - expected);
        if (distance < bestDistance) {
          best = k;
          bestDistance = distance;
        }
      }
      // A break whose pause is nowhere near stays inside the phrase.
      if (best < 0 || bestDistance > Math.max(0.4, totalSpeech * 0.15)) continue;
      lastInterval = best;
    }
    segments.push({
      from: firstWord,
      to: i,
      speech: speech.slice(firstInterval, lastInterval + 1),
    });
    firstWord = i + 1;
    firstInterval = lastInterval + 1;
  }

  const boundaries: TTSWordBoundary[] = [];
  for (const segment of segments) {
    const share = (i: number) => weights[i]! * (i === segment.to ? PHRASE_FINAL_STRETCH : 1);
    let segmentWeight = 0;
    for (let i = segment.from; i <= segment.to; i++) segmentWeight += share(i);
    const segmentSpeech = spoken(segment.speech);
    let at = 0;
    for (let i = segment.from; i <= segment.to; i++) {
      const length = (share(i) / segmentWeight) * segmentSpeech;
      const start = clockAt(segment.speech, at);
      const end = clockAt(segment.speech, at + length);
      boundaries.push({
        offset: Math.round(start * mediaRate * TICKS_PER_SECOND),
        duration: Math.round((end - start) * mediaRate * TICKS_PER_SECOND),
        text: words[i]![0],
      });
      at += length;
    }
  }
  return boundaries;
};
