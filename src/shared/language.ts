/** The only language identifiers accepted across process boundaries. */
export const LANGUAGES = ['en', 'de', 'es', 'ru', 'zh-CN'] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language === value);
}

/** Match the web wallet: unspecified and Traditional Chinese fall back to English. */
export function resolveLanguage(preferred: readonly string[], locale?: string): Language {
  for (const entry of preferred.length ? preferred : [locale ?? '']) {
    const tag = entry.toLowerCase().replaceAll('_', '-');
    if (/^zh-(?:cn|sg|hans)(?:-|$)/u.test(tag)) return 'zh-CN';
    for (const language of ['en', 'de', 'es', 'ru'] as const) {
      if (tag === language || tag.startsWith(`${language}-`)) return language;
    }
  }
  return 'en';
}
