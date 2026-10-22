import en from './locales/en';
import de from './locales/de';
import es from './locales/es';
import ru from './locales/ru';
import zhCN from './locales/zh-CN';
import type { Language } from './language';

export const catalogs = { en, de, es, ru, 'zh-CN': zhCN };
export type MessageKey = keyof typeof en;
export type Values = Readonly<Record<string, string | number>>;

/** One replacement pass: supplied data is never interpreted as catalog syntax. */
export function translate(language: Language, key: MessageKey, values: Values = {}): string {
  return catalogs[language][key].replace(/\{\{(\w+)\}\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing translation value: ${name}`);
    return String(value);
  });
}

export function translator(language: Language) {
  return (key: MessageKey, values?: Values): string => translate(language, key, values);
}

export function minutesLabel(language: Language, count: number): string {
  const plural = new Intl.PluralRules(language).select(count);
  const form = plural === 'one' || plural === 'few' || plural === 'many' ? plural : 'other';
  return translate(language, `settings.minutes_${form}`, { count });
}
