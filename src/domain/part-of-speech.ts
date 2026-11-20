export const PARTS_OF_SPEECH = {
  n: '名词',
  v: '动词',
  adj: '形容词',
  adv: '副词',
  prep: '介词',
  pron: '代词',
  num: '数词',
  conj: '连词',
  int: '感叹词',
  aux: '助动词',
  art: '冠词',
  det: '限定词',
} as const

export type PartOfSpeech = keyof typeof PARTS_OF_SPEECH

const aliases: Readonly<Record<string, PartOfSpeech>> = {
  vt: 'v',
  vi: 'v',
  a: 'adj',
  ad: 'adv',
  interjection: 'int',
}

export function normalizePartOfSpeech(value: string): PartOfSpeech | undefined {
  const raw = value.normalize('NFKC').trim().toLowerCase().replace(/\.$/, '')
  if (Object.hasOwn(PARTS_OF_SPEECH, raw)) return raw as PartOfSpeech
  if (Object.hasOwn(aliases, raw)) return aliases[raw]
  return (Object.keys(PARTS_OF_SPEECH) as PartOfSpeech[]).find(
    (part) => PARTS_OF_SPEECH[part] === raw,
  )
}
