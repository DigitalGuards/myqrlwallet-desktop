import { useEffect, useState } from 'react';
import { isLanguage, type Language } from './language';
import { translate, translator, type MessageKey } from './i18n';

export interface NativeLanguageBridge {
  getLanguage(): Promise<Language>;
  onLanguageChanged(callback: (language: Language) => void): () => void;
}

/** Subscribe before the snapshot; a newer event always wins over an in-flight read. */
export function useNativeLanguage(bridge: NativeLanguageBridge, title: MessageKey) {
  const [language, setLanguage] = useState<Language>('en');
  useEffect(() => {
    let stale = false;
    const off = bridge.onLanguageChanged((next) => {
      stale = true;
      if (isLanguage(next)) setLanguage(next);
    });
    void bridge
      .getLanguage()
      .then((next) => {
        if (!stale && isLanguage(next)) setLanguage(next);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
      off();
    };
  }, [bridge]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, title);
  }, [language, title]);
  return { language, t: translator(language) };
}
