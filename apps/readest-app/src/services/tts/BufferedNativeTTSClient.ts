import { parseSSMLMarks } from '@/utils/ssml';
import { BufferedTTSClient } from './BufferedTTSClient';
import { groupNativeVoices } from './nativeVoices';
import { SystemSpeechProvider } from './providers/system';
import { SpeechSynthesisRequest } from './providers/types';
import { TTSCapabilities, TTSMessageEvent } from './TTSClient';
import type { TTSController } from './TTSController';

// Android system voices played through the buffered pipeline: sentences are
// rendered ahead of the playhead (SystemSpeechProvider) and played by the
// app, so the next one is usually ready before the current one ends.
// NativeTTSClient speaks the same voices directly, asking the engine for each
// sentence only once the previous one has finished playing.
export class BufferedNativeTTSClient extends BufferedTTSClient {
  readonly #system: SystemSpeechProvider;
  // Mirror of the base client's primary language, which parses marks the
  // same way the scheduler does.
  #primaryLang = 'en';

  constructor(controller?: TTSController) {
    const provider = new SystemSpeechProvider();
    super(provider, controller);
    this.#system = provider;
  }

  override async init(): Promise<boolean> {
    // Engine first: listing voices before init would bind a second engine.
    this.initialized = await this.provider.init();
    this.voices = this.initialized ? await this.provider.getAllVoices() : [];
    return this.initialized;
  }

  override async *speak(ssml: string, signal: AbortSignal, preload = false) {
    // The engine renders one sentence at a time, so the provider orders the
    // work: the paragraph about to play is queued ahead of preloaded ones,
    // and a preload is only queued, never synthesized on the spot.
    const reqs = await this.#requestsFor(ssml);
    if (!signal.aborted) this.#system.prefetch(reqs, !preload);
    if (preload) {
      yield { code: 'end', message: 'Preload queued' } as TTSMessageEvent;
      return;
    }
    yield* super.speak(ssml, signal);
  }

  // The same requests the scheduler will make for these marks.
  async #requestsFor(ssml: string): Promise<SpeechSynthesisRequest[]> {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    const reqs: SpeechSynthesisRequest[] = [];
    for (const mark of marks) {
      const voice = await this.getVoiceIdFromLang(mark.language);
      reqs.push(this.buildRequest(mark.language, mark.text, voice));
    }
    return reqs;
  }

  override setPrimaryLang(lang: string) {
    super.setPrimaryLang(lang);
    this.#primaryLang = lang;
  }

  override async getVoices(lang: string) {
    return groupNativeVoices(await this.getAllVoices(), lang, this.initialized);
  }

  override getCapabilities(): TTSCapabilities {
    // synthesizeToFile() reports no word timings.
    return { ...super.getCapabilities(), wordBoundaries: false };
  }
}
