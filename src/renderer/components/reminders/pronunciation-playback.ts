interface SystemVoice {
  voiceURI: string
  name: string
  lang: string
  localService: boolean
  default: boolean
}

const dictionaryWaitMs = 650
const spokenEnglish = [
  'samantha',
  'ava',
  'allison',
  'zoe',
  'alex',
  'tom',
  'daniel',
  'serena',
  'karen',
  'moira',
  'tessa',
  'rishi',
  'tara',
  'aman',
  'kathy',
]
const effectVoices = new Set([
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'deranged',
  'fred',
  'good news',
  'hysterical',
  'jester',
  'junior',
  'organ',
  'pipe organ',
  'princess',
  'ralph',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox',
])

function baseName(voice: SystemVoice) {
  return voice.name.toLowerCase().split('(', 1)[0]?.trim() ?? ''
}

export function listLocalVoices<T extends SystemVoice>(voices: readonly T[], language: string) {
  return [
    ...new Map(
      voices
        .filter(
          (voice) =>
            voice.localService &&
            voice.voiceURI &&
            voice.lang.toLowerCase().split(/[-_]/, 1)[0] === language &&
            (language !== 'en' || !effectVoices.has(baseName(voice))),
        )
        .map((voice) => [voice.voiceURI, voice]),
    ).values(),
  ]
}

export function selectLocalVoice<T extends SystemVoice>(
  voices: readonly T[],
  language: string,
  selected?: string | null,
): T | undefined {
  const matching = listLocalVoices(voices, language)
  const preferred = matching.find((voice) => voice.voiceURI === selected)
  if (preferred) return preferred
  if (language === 'en') {
    const upgraded = matching.find(
      (voice) =>
        spokenEnglish.includes(baseName(voice)) &&
        /\b(?:premium|enhanced|natural)\b/i.test(voice.name),
    )
    if (upgraded) return upgraded
    for (const name of spokenEnglish) {
      const voice = matching.find((candidate) => baseName(candidate) === name)
      if (voice) return voice
    }
  }
  return matching.find((voice) => voice.default) ?? matching[0]
}

/** Let the main-process lookup finish and fill its cache even after local playback starts. */
export async function waitForRecording<T>(
  recording: Promise<T>,
  canSpeakLocally: boolean,
): Promise<T | undefined> {
  if (!canSpeakLocally) return recording
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), dictionaryWaitMs)
  })
  try {
    return await Promise.race([recording, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
