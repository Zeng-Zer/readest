// Android system TTS (TextToSpeech) as a SpeechProvider. Each sentence is
// rendered to WAV with synthesizeToFile() instead of being spoken, so the
// buffered client can synthesize ahead of the playhead. Speaking cannot: the
// framework blocks a speaking engine once ~500ms of unplayed audio is queued,
// so the next sentence only starts synthesizing as the current one ends.
//
// A local engine renders one utterance at a time, so requests are serialized
// here instead of queued in the engine: a sentence the player is waiting for
// goes first, then the rest of the paragraph being played, then preloaded
// paragraphs in the order they were queued. Rendered audio stays in memory
// only (WAV is ~10x the size of Edge's MP3), within a byte budget.

import { invoke } from '@tauri-apps/api/core';
import type { TTSVoice } from '../types';
import { fetchNativeVoices } from '../nativeVoices';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

const WAV_HEADER_BYTES = 44;

// About 10 minutes of 24kHz mono 16-bit audio: well past the controller's
// preload horizon, so prefetched sentences survive until they play.
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

// The controller preloads the upcoming paragraphs again around every
// paragraph start. When a paragraph starts playing, a preload nobody asked
// for again within this long is for a position the reader has left.
export const PRELOAD_TTL_MS = 2000;

interface Job {
  key: string;
  req: SpeechSynthesisRequest;
  promise: Promise<ArrayBuffer>;
  resolve: (audio: ArrayBuffer) => void;
  reject: (error: unknown) => void;
  // The player is waiting for it, not just a prefetch.
  urgent: boolean;
  // The latest prefetch() that asked for it, and when.
  batch: number;
  requestedAt: number;
}

const requestKey = (req: SpeechSynthesisRequest) =>
  [req.voice, req.lang, req.pitch, req.text].join('\u0000');

const fromBase64 = (data: string): ArrayBuffer => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const abortError = () => new DOMException('Aborted', 'AbortError');

export class SystemSpeechProvider implements SpeechProvider {
  // Same id as NativeTTSClient: both play the system voices, so they share
  // the persisted client and per-language voice preferences.
  readonly id = 'native-tts';
  readonly label = 'System TTS';
  readonly cacheable = false;

  #cache = new Map<string, ArrayBuffer>();
  #cacheBytes = 0;
  #pending = new Map<string, Job>();
  #running: Job | null = null;
  #batch = 0;
  // The prefetch() batch of the paragraph being played.
  #playingBatch = -1;

  async init(): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean }>('plugin:native-tts|init');
      return result.success;
    } catch (error) {
      console.error('Failed to initialize system TTS:', error);
      return false;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    try {
      return await fetchNativeVoices();
    } catch (error) {
      console.error('Failed to get system TTS voices:', error);
      return [];
    }
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    if (signal.aborted) throw abortError();
    const key = requestKey(req);
    let audio = this.#cacheGet(key);
    if (!audio) {
      const job = this.#enqueue(key, req, true);
      this.#pump();
      audio = await this.#waitFor(job, signal);
    }
    // A fresh copy per call: decodeAudioData detaches its input.
    return { audio: audio.slice(0), boundaries: [] };
  }

  // Queue one paragraph's sentences behind whatever the player is waiting
  // for; the paragraph being played goes ahead of preloaded ones. Fire and
  // forget: a sentence that fails here is rendered again when the player asks
  // for it.
  prefetch(reqs: SpeechSynthesisRequest[], playing = false): void {
    if (reqs.length === 0) return;
    this.#batch++;
    if (playing) this.#playingBatch = this.#batch;
    for (const req of reqs) {
      const key = requestKey(req);
      if (!this.#cache.has(key)) this.#enqueue(key, req, false);
    }
    if (playing) this.#dropStalePreloads();
    this.#pump();
  }

  async shutdown(): Promise<void> {
    for (const job of this.#pending.values()) job.reject(abortError());
    this.#pending.clear();
    this.#cache.clear();
    this.#cacheBytes = 0;
  }

  #enqueue(key: string, req: SpeechSynthesisRequest, urgent: boolean): Job {
    const existing = this.#running?.key === key ? this.#running : this.#pending.get(key);
    if (existing) {
      if (urgent) {
        existing.urgent = true;
      } else {
        existing.batch = this.#batch;
        existing.requestedAt = Date.now();
      }
      return existing;
    }
    let resolve!: Job['resolve'];
    let reject!: Job['reject'];
    const promise = new Promise<ArrayBuffer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A prefetch can fail with nobody waiting on it.
    promise.catch(() => {});
    const job = {
      key,
      req,
      promise,
      resolve,
      reject,
      urgent,
      batch: this.#batch,
      requestedAt: Date.now(),
    };
    this.#pending.set(key, job);
    return job;
  }

  #dropStalePreloads(): void {
    const cutoff = Date.now() - PRELOAD_TTL_MS;
    for (const job of this.#pending.values()) {
      if (!job.urgent && job.requestedAt < cutoff) {
        this.#pending.delete(job.key);
        job.reject(abortError());
      }
    }
  }

  #waitFor(job: Job, signal: AbortSignal): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        // Nobody waits for it now; left queued as a prefetch, it is dropped
        // once the reader has moved on.
        if (job !== this.#running) job.urgent = false;
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      job.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  #pump(): void {
    if (this.#running) return;
    const job = this.#nextJob();
    if (!job) return;
    this.#pending.delete(job.key);
    this.#running = job;
    this.#render(job.req)
      .then((audio) => {
        this.#cachePut(job.key, audio);
        job.resolve(audio);
      }, job.reject)
      .finally(() => {
        this.#running = null;
        this.#pump();
      });
  }

  #nextJob(): Job | undefined {
    let playing: Job | undefined;
    let preloaded: Job | undefined;
    for (const job of this.#pending.values()) {
      if (job.urgent) return job;
      if (job.batch === this.#playingBatch) playing ??= job;
      // Preloads wait for a paragraph to play: a session must not start
      // behind a paragraph that was merely preloaded.
      else if (this.#playingBatch >= 0) preloaded ??= job;
    }
    return playing ?? preloaded;
  }

  async #render(req: SpeechSynthesisRequest): Promise<ArrayBuffer> {
    const { data } = await invoke<{ data: string }>('plugin:native-tts|synthesize', {
      payload: { text: req.text, voice: req.voice || undefined, lang: req.lang, pitch: req.pitch },
    });
    const audio = fromBase64(data);
    // Header only: the engine had nothing to say (e.g. bare punctuation), and
    // it would render the same nothing every time.
    if (audio.byteLength <= WAV_HEADER_BYTES) {
      throw new SpeechSynthesisPermanentError('No audio data received.');
    }
    return audio;
  }

  #cacheGet(key: string): ArrayBuffer | undefined {
    const audio = this.#cache.get(key);
    if (audio) {
      this.#cache.delete(key);
      this.#cache.set(key, audio);
    }
    return audio;
  }

  #cachePut(key: string, audio: ArrayBuffer): void {
    const previous = this.#cache.get(key);
    if (previous) this.#cacheBytes -= previous.byteLength;
    this.#cache.delete(key);
    this.#cache.set(key, audio);
    this.#cacheBytes += audio.byteLength;
    for (const [oldKey, oldAudio] of this.#cache) {
      if (this.#cacheBytes <= CACHE_BUDGET_BYTES) break;
      this.#cache.delete(oldKey);
      this.#cacheBytes -= oldAudio.byteLength;
    }
  }
}
