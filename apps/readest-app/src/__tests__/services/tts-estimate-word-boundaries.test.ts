import { describe, expect, test } from 'vitest';
import { estimateWordBoundaries, parseWav } from '@/services/tts/estimateWordBoundaries';
import { SAMPLE_RATE, wav } from './tts-wav-fixture';

const TICKS = 10_000_000;

const startOf = (boundaries: { offset: number; text: string }[], word: string) =>
  boundaries.find((b) => b.text === word)!.offset / TICKS;

describe('estimateWordBoundaries', () => {
  test('reads mono 16-bit PCM and rejects anything else', () => {
    const parsed = parseWav(wav(0.5, [[0, 0.5]]));
    expect(parsed?.sampleRate).toBe(SAMPLE_RATE);
    expect(parsed?.samples.length).toBe(12000);
    expect(parseWav(new ArrayBuffer(100))).toBeNull();
  });

  test('starts the first word where the voice starts, not at the leading silence', () => {
    const boundaries = estimateWordBoundaries('Hello there.', wav(1.5, [[0.4, 1.2]]));
    expect(boundaries.map((b) => b.text)).toEqual(['Hello', 'there']);
    expect(startOf(boundaries, 'Hello')).toBeCloseTo(0.4, 1);
  });

  test('starts the word after a comma where the voice resumes after the pause', () => {
    const audio = wav(2.6, [
      [0.2, 1.2],
      [1.5, 2.5],
    ]);
    const boundaries = estimateWordBoundaries('One two three, four five six.', audio);
    expect(startOf(boundaries, 'four')).toBeCloseTo(1.5, 1);
    // The phrase before the pause ends at the pause, not inside it.
    const three = boundaries.find((b) => b.text === 'three')!;
    expect((three.offset + three.duration) / TICKS).toBeCloseTo(1.2, 1);
  });

  test('gives the last word of a phrase more time, as speech slows before a pause', () => {
    const boundaries = estimateWordBoundaries('one two six.', wav(1.2, [[0.2, 1.2]]));
    const [one, two, six] = boundaries.map((b) => b.duration);
    expect(one).toBeCloseTo(two!, -3);
    expect(six! / one!).toBeCloseTo(2.2, 1);
  });

  test('keeps words with apostrophes and hyphens whole', () => {
    const boundaries = estimateWordBoundaries("the Rabbit's daisy-chain", wav(1, [[0, 1]]));
    expect(boundaries.map((b) => b.text)).toEqual(['the', "Rabbit's", 'daisy-chain']);
  });

  test('reports times in rate-1.0 media time for audio rendered faster', () => {
    const audio = wav(1.5, [[0.4, 1.2]]);
    const atRate = estimateWordBoundaries('Hello there.', audio, 2);
    expect(startOf(atRate, 'Hello')).toBeCloseTo(0.8, 1);
  });

  test('has nothing to offer for silence or unreadable audio', () => {
    expect(estimateWordBoundaries('Hello.', wav(1, []))).toEqual([]);
    expect(estimateWordBoundaries('Hello.', new ArrayBuffer(64))).toEqual([]);
  });
});
