import { translate, type MessageKey, type Values } from '../shared/i18n';
import type { Language } from '../shared/language';
import { updateSettings } from './settingsFile';

let language: Language = 'en';
const listeners = new Set<(language: Language) => void>();

export const getLanguage = (): Language => language;
export const t = (key: MessageKey, values?: Values): string => translate(language, key, values);

export function applyLanguage(next: Language): void {
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener(next);
}

export function onLanguageChanged(listener: (language: Language) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Serialize renderer changes so a slower write cannot restore an older choice.
let pending = Promise.resolve();
export function setLanguage(next: Language): Promise<void> {
  const result = pending.then(async () => {
    await updateSettings({ language: next });
    applyLanguage(next);
  });
  pending = result.catch(() => undefined);
  return result;
}
