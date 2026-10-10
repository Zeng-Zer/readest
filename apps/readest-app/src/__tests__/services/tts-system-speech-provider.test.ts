import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

import { PRELOAD_TTL_MS, SystemSpeechProvider } from '@/services/tts/providers/system';
import {
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
} from '@/services/tts/providers/types';

// A fake engine: each synthesize call renders until the test finishes it.
type Render = {
  text: string;
  payload: Record<string, unknown>;
  finish: (bytes: number) => void;
  done: boolean;
};
let renders: Render[];

const req = (text: string): SpeechSynthesisRequest => ({
  lang: 'en',
  text,
  voice: 'en-us-voice',
  pitch: 1,
});
const signal = () => new AbortController().signal;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const rendered = () => renders.map((render) => render.text);

const finish = async (text: string, bytes = 100) => {
  const render = renders.find((r) => r.text === text && !r.done);
  if (!render) throw new Error(`"${text}" is not rendering`);
  render.done = true;
  render.finish(bytes);
  await flush();
};

describe('SystemSpeechProvider', () => {
  let provider: SystemSpeechProvider;

  beforeEach(() => {
    renders = [];
    h.invoke.mockReset();
    h.invoke.mockImplementation(
      (command: string, args?: { payload: Record<string, unknown> }) =>
        new Promise((resolve) => {
          if (command !== 'plugin:native-tts|synthesize') return resolve({ success: true });
          renders.push({
            text: args!.payload['text'] as string,
            payload: args!.payload,
            finish: (bytes) => resolve({ data: btoa('\u0001'.repeat(bytes)) }),
            done: false,
          });
        }),
    );
    provider = new SystemSpeechProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders at the requested voice, pitch and rate', async () => {
    const result = provider.synthesize(
      { lang: 'en-US', text: 'Hello there.', voice: 'en-us-voice', pitch: 1.2, rate: 1.75 },
      signal(),
    );
    await flush();
    expect(renders[0]!.payload).toEqual({
      text: 'Hello there.',
      voice: 'en-us-voice',
      lang: 'en-US',
      pitch: 1.2,
      rate: 1.75,
    });
    await finish('Hello there.', 100);
    expect((await result).audio.byteLength).toBe(100);
  });

  test('keeps a sentence rendered at one rate apart from another rate', async () => {
    provider.prefetch([{ ...req('Twice.'), rate: 1.5 }], true);
    await flush();
    await finish('Twice.');
    const other = provider.synthesize({ ...req('Twice.'), rate: 2 }, signal());
    await flush();
    expect(renders.map((r) => r.payload['rate'])).toEqual([1.5, 2]);
    await finish('Twice.');
    await other;
  });

  test('renders one sentence at a time', async () => {
    const first = provider.synthesize(req('One.'), signal());
    const second = provider.synthesize(req('Two.'), signal());
    await flush();
    expect(rendered()).toEqual(['One.']);

    await finish('One.');
    expect(rendered()).toEqual(['One.', 'Two.']);
    await finish('Two.');
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  test('does not preload anything before a paragraph plays', async () => {
    provider.prefetch([req('Later.')]);
    await flush();
    expect(renders).toHaveLength(0);
  });

  test('renders the paragraph being played before preloaded ones queued earlier', async () => {
    // The controller's preloads and the paragraph it starts race each other.
    provider.prefetch([req('Next 1.'), req('Next 2.')]);
    provider.prefetch([req('Now 1.'), req('Now 2.')], true);
    await flush();

    await finish('Now 1.');
    await finish('Now 2.');
    await finish('Next 1.');
    await finish('Next 2.');
    expect(rendered()).toEqual(['Now 1.', 'Now 2.', 'Next 1.', 'Next 2.']);
  });

  test('renders the sentence the player waits for before the rest of the queue', async () => {
    provider.prefetch([req('Now 1.'), req('Now 2.')], true);
    await flush();
    const wanted = provider.synthesize(req('Elsewhere.'), signal());

    await finish('Now 1.');
    expect(rendered()).toEqual(['Now 1.', 'Elsewhere.']);
    await finish('Elsewhere.');
    await expect(wanted).resolves.toBeDefined();
  });

  test('serves a prefetched sentence from memory, as a fresh copy each time', async () => {
    provider.prefetch([req('Once.')], true);
    await flush();
    await finish('Once.');

    const first = await provider.synthesize(req('Once.'), signal());
    const second = await provider.synthesize(req('Once.'), signal());
    expect(renders).toHaveLength(1);
    // decodeAudioData detaches its input, so callers must never share one.
    expect(first.audio).not.toBe(second.audio);
    expect(second.audio.byteLength).toBe(100);
  });

  test('waits for a sentence already rendering instead of rendering it again', async () => {
    provider.prefetch([req('Busy.')], true);
    await flush();
    const result = provider.synthesize(req('Busy.'), signal());

    await finish('Busy.');
    expect((await result).audio.byteLength).toBe(100);
    expect(renders).toHaveLength(1);
  });

  test('drops preloads for a position the reader has left', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    provider.prefetch([req('Old 1.')], true);
    provider.prefetch([req('Old next.')]);
    await flush();

    // The reader jumps elsewhere: a new paragraph plays, with new preloads.
    now.mockReturnValue(10_000 + PRELOAD_TTL_MS + 1);
    provider.prefetch([req('New 1.')], true);
    provider.prefetch([req('New next.')]);

    await finish('Old 1.');
    await finish('New 1.');
    await finish('New next.');
    expect(rendered()).toEqual(['Old 1.', 'New 1.', 'New next.']);
  });

  test('keeps preloads the controller asks for again when the next paragraph starts', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    provider.prefetch([req('P1.')], true);
    provider.prefetch([req('P2.')]);
    provider.prefetch([req('P3.')]);
    await flush();

    // P2 starts much later; its preloads arrive just before it does.
    now.mockReturnValue(20_000);
    provider.prefetch([req('P3.')]);
    provider.prefetch([req('P2.')], true);

    await finish('P1.');
    await finish('P2.');
    await finish('P3.');
    expect(rendered()).toEqual(['P1.', 'P2.', 'P3.']);
  });

  test('skips a sentence the engine renders as silence', async () => {
    const skipped = expect(provider.synthesize(req('...'), signal())).rejects.toBeInstanceOf(
      SpeechSynthesisPermanentError,
    );
    await flush();
    await finish('...', 44); // a WAV header and nothing else
    await skipped;
  });

  test('stops waiting when the player aborts', async () => {
    provider.prefetch([req('Now 1.')], true);
    await flush();
    const abort = new AbortController();
    const waiting = provider.synthesize(req('Later.'), abort.signal);

    abort.abort();
    await expect(waiting).rejects.toThrow('Aborted');
  });
});
