import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TTSMessageEvent } from '@/services/tts/TTSClient';
import type { TTSController } from '@/services/tts/TTSController';
import { FakeAudioContext } from './tts-fake-audio';
import { wav } from './tts-wav-fixture';

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  // Marks per SSML string: each test's paragraphs are keyed by a fake SSML.
  paragraphs: {} as Record<string, Array<{ name: string; text: string; language: string }>>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => h.invoke(command, args),
  addPluginListener: vi.fn(),
}));

vi.mock('@/utils/ssml', () => ({
  parseSSMLMarks: vi.fn((ssml: string) => ({ marks: h.paragraphs[ssml] ?? [] })),
}));

vi.mock('@/utils/misc', () => ({
  getUserLocale: vi.fn((lang: string) => (lang === 'en' ? 'en-US' : lang)),
  getOSPlatform: vi.fn(() => 'android'),
  stubTranslation: (key: string) => key,
}));

vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => false,
}));

vi.mock('@/services/tts/TTSUtils', () => ({
  TTSUtils: {
    getPreferredVoice: vi.fn(() => null),
    sortVoicesPreferLocaleFunc: () => () => 0,
  },
}));

vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const SECOND_OF_AUDIO = btoa('\u0000'.repeat(24000));

type ClientClass = typeof import('@/services/tts/BufferedNativeTTSClient').BufferedNativeTTSClient;

describe('BufferedNativeTTSClient', () => {
  let BufferedNativeTTSClient: ClientClass;
  let rendered: string[];

  beforeEach(async () => {
    vi.resetModules();
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    rendered = [];
    h.paragraphs = {
      '<p1/>': [
        { name: '0', text: 'First sentence.', language: 'en' },
        { name: '1', text: 'Second sentence.', language: 'en' },
      ],
      '<p2/>': [{ name: '0', text: 'Next paragraph.', language: 'en' }],
    };
    h.invoke.mockReset();
    h.invoke.mockImplementation(async (command: string, args?: { payload: { text: string } }) => {
      if (command === 'plugin:native-tts|init') return { success: true };
      if (command === 'plugin:native-tts|get_all_voices') {
        return { voices: [{ id: 'en-us-x-local', name: 'en-us-x-local', lang: 'en-US' }] };
      }
      if (command === 'plugin:native-tts|synthesize') {
        rendered.push(args!.payload.text);
        return { data: SECOND_OF_AUDIO };
      }
      return undefined;
    });
    // The app loads constants (and through it EdgeTTSClient, the first
    // BufferedTTSClient subclass) at startup, long before the reader asks for
    // this client; loading it cold trips the constants <-> EdgeTTSClient cycle.
    await import('@/services/constants');
    ({ BufferedNativeTTSClient } = await import('@/services/tts/BufferedNativeTTSClient'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const startClient = async () => {
    const controller = {
      dispatchSpeakMark: vi.fn(),
      prepareSpeakWords: vi.fn(),
      dispatchSpeakWord: vi.fn(),
    };
    const client = new BufferedNativeTTSClient(controller as unknown as TTSController);
    await client.init();
    return client;
  };

  const speak = (client: InstanceType<ClientClass>, ssml: string, preload = false) => {
    const events: TTSMessageEvent[] = [];
    const done = (async () => {
      for await (const event of client.speak(ssml, new AbortController().signal, preload)) {
        events.push(event);
      }
    })();
    return { events, done };
  };

  test('binds the engine before listing its voices', async () => {
    await startClient();
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      'plugin:native-tts|init',
      'plugin:native-tts|get_all_voices',
    ]);
  });

  test('a preload only queues the paragraph', async () => {
    const client = await startClient();
    const { events, done } = speak(client, '<p2/>', true);
    await done;
    await flush();
    expect(events.map((e) => e.code)).toEqual(['end']);
    expect(rendered).toEqual([]);
  });

  test('renders the next paragraph while the current one plays', async () => {
    const client = await startClient();
    await speak(client, '<p2/>', true).done;
    const current = speak(client, '<p1/>');
    for (let i = 0; i < 10; i++) await flush();

    // Everything is ready before a single second of audio has played.
    expect(FakeAudioContext.instances[0]!.currentTime).toBe(0);
    expect(rendered).toEqual(['First sentence.', 'Second sentence.', 'Next paragraph.']);

    await FakeAudioContext.instances[0]!.advanceTo(10);
    await current.done;
    const next = speak(client, '<p2/>');
    await flush();
    await FakeAudioContext.instances[0]!.advanceTo(20);
    await next.done;
    expect(next.events.map((e) => e.code)).toEqual(['boundary', 'end']);
    expect(rendered).toHaveLength(3);
  });

  test('has the engine render the playback rate instead of stretching it', async () => {
    const client = await startClient();
    await client.setRate(1.75);
    const { done } = speak(client, '<p2/>');
    for (let i = 0; i < 5; i++) await flush();

    const rates = h.invoke.mock.calls
      .filter(([command]) => command === 'plugin:native-tts|synthesize')
      .map(([, args]) => (args as { payload: { rate: number } }).payload.rate);
    expect(rates).toEqual([1.75]);
    // One second of audio, played as rendered: not time-stretched again.
    expect(FakeAudioContext.instances[0]!.sources[0]!.buffer!.duration).toBeCloseTo(1, 2);
    await FakeAudioContext.instances[0]!.advanceTo(5);
    await done;
  });

  test('stretches only the rate beyond what the engine renders', async () => {
    const client = await startClient();
    await client.setRate(3);
    const { done } = speak(client, '<p2/>');
    for (let i = 0; i < 5; i++) await flush();

    const rates = h.invoke.mock.calls
      .filter(([command]) => command === 'plugin:native-tts|synthesize')
      .map(([, args]) => (args as { payload: { rate: number } }).payload.rate);
    expect(rates).toEqual([2]);
    expect(FakeAudioContext.instances[0]!.sources[0]!.buffer!.duration).toBeCloseTo(1 / 1.5, 1);
    await FakeAudioContext.instances[0]!.advanceTo(5);
    await done;
  });

  test('highlights word by word from timings estimated on the audio', async () => {
    const audio = Buffer.from(wav(1, [[0.1, 0.9]])).toString('base64');
    h.invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:native-tts|init') return { success: true };
      if (command === 'plugin:native-tts|get_all_voices') return { voices: [] };
      return { data: audio };
    });
    const controller = {
      dispatchSpeakMark: vi.fn(),
      prepareSpeakWords: vi.fn(),
      dispatchSpeakWord: vi.fn(),
    };
    const client = new BufferedNativeTTSClient(controller as unknown as TTSController);
    await client.init();
    expect(client.getCapabilities().wordBoundaries).toBe(true);

    const { done } = speak(client, '<p2/>');
    for (let i = 0; i < 5; i++) await flush();
    expect(controller.prepareSpeakWords).toHaveBeenCalledWith(['Next', 'paragraph']);
    await FakeAudioContext.instances[0]!.advanceTo(5);
    await done;
  });

  test('lists the system voices like the direct-speak client', async () => {
    const client = await startClient();
    const groups = await client.getVoices('en');
    expect(groups.map((g) => [g.id, g.name])).toEqual([['default', 'System TTS']]);
    expect(groups[0]!.voices.map((v) => v.id)).toEqual(['en-us-x-local']);
  });
});
