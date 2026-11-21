export const BANK_LANGUAGES = {
  en: { label: '英语', pronunciation: true },
  ja: { label: '日语', pronunciation: false },
  ko: { label: '韩语', pronunciation: false },
  zh: { label: '中文', pronunciation: false },
  fr: { label: '法语', pronunciation: false },
  de: { label: '德语', pronunciation: false },
  es: { label: '西班牙语', pronunciation: false },
  other: { label: '其他语言', pronunciation: false },
} as const

export type BankLanguage = keyof typeof BANK_LANGUAGES
export const DEFAULT_BANK_LANGUAGE: BankLanguage = 'en'

export function isBankLanguage(value: unknown): value is BankLanguage {
  return typeof value === 'string' && Object.hasOwn(BANK_LANGUAGES, value)
}
