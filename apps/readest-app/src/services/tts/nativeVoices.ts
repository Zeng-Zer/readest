// System (Android TextToSpeech / iOS AVSpeechSynthesizer) voice listing and
// grouping, shared by NativeTTSClient and BufferedNativeTTSClient, which play
// the same voices.

import { invoke } from '@tauri-apps/api/core';
import { getUserLocale, stubTranslation as _ } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { TTSVoice, TTSVoicesGroup } from './types';
import { TTSUtils } from './TTSUtils';

const TTSEngines = {
  default: 'System TTS',
  msctts: 'Msc TTS',
  mstrans: 'MSTrans TTS',
  microsoft: 'Microsoft TTS',
  bytedance: 'ByteDance TTS',
  peiyinya: 'PeiYinYa TTS',
  huoshan: 'HuoShan TTS',
  sougou: 'Sougou TTS',
  xiaomi: 'XiaoMi TTS',
  bdetts: 'BDeTTS',
  bdotts: 'BDoTTS',
  vcstts: 'VcsTTS',
  isstts: 'IssTTS',
  xfpeiyin: 'XFPeiYin',
  azure: 'Azure TTS',
  edgetts: 'Edge TTS',
  google: 'Google TTS',
  gemini: 'Gemini TTS',
  weread: 'WeRead TTS',
  aispeech: 'Aispeech',
} as Record<string, string>;

export const fetchNativeVoices = async (): Promise<TTSVoice[]> => {
  const result = await invoke<{ voices: TTSVoice[] }>('plugin:native-tts|get_all_voices');
  // Match Web Speech's Apple voice-family exclusions. iOS also exposes
  // novelty and legacy Eloquence voices through the native API.
  return result.voices.filter(
    (voice) =>
      !voice.id.startsWith('com.apple.eloquence.') &&
      !voice.id.startsWith('com.apple.speech.synthesis.voice.'),
  );
};

export const groupNativeVoices = (
  voices: TTSVoice[],
  lang: string,
  initialized: boolean,
): TTSVoicesGroup[] => {
  const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
  // Match by primary language so the voice set stays the same across a book
  // whose sections mix region variants (e.g. en-US front matter and en-GB
  // body text); the requested locale's voices sort first. See #4033.
  const filteredVoices = voices.filter((v) => isSameLang(v.lang, lang));
  const voiceGroups = new Map<string, TTSVoice[]>();
  filteredVoices.forEach((voice) => {
    const { name, lang } = voice;
    let groupId = voice.id.split('_')[0]!;
    if (groupId in TTSEngines) {
      voice.name = name
        .replace(`${groupId}_`, '')
        .replace(`${lang}-`, '')
        .replace('Neural', '')
        .trim();
    } else {
      groupId = 'default';
    }
    voice.name = voice.name.replace('NOT_SET', _('Default'));
    if (!voiceGroups.has(groupId)) {
      voiceGroups.set(groupId, []);
    }
    voiceGroups.get(groupId)!.push(voice);
  });

  return Array.from(voiceGroups.entries())
    .map(
      ([groupId, voices]) =>
        ({
          id: groupId,
          name: TTSEngines[groupId] || groupId,
          voices: voices.sort(TTSUtils.sortVoicesPreferLocaleFunc(locale)),
          disabled: !initialized || voices.length === 0,
        }) as TTSVoicesGroup,
    )
    .sort((a, b) => {
      if (a.id === 'default') return -1;
      if (b.id === 'default') return 1;
      return a.id.localeCompare(b.id);
    });
};
