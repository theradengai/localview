import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { LANGUAGE_PREFERENCE_EVENT, setLanguagePreference, type LanguagePreference } from './i18n';
import { useI18n } from './useI18n';

const NATIVE_LANGUAGE_EVENT = 'localview-ui-language';
let menuUpdates: Promise<unknown> = Promise.resolve();

export function useNativeLanguageSync() {
  const { locale } = useI18n();
  useEffect(() => {
    if (!isTauri()) return;
    menuUpdates = menuUpdates.catch(() => undefined)
      .then(() => invoke('set_ui_language', { language: locale })).catch(error => {
      console.error('LocalView could not update native menu labels:', error);
    });
  }, [locale]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const broadcast = (event: Event) => {
      const value = (event as CustomEvent<LanguagePreference>).detail;
      void emit(NATIVE_LANGUAGE_EVENT, value).catch(error => {
        console.error('LocalView could not synchronize interface language:', error);
      });
    };
    window.addEventListener(LANGUAGE_PREFERENCE_EVENT, broadcast);
    void listen<unknown>(NATIVE_LANGUAGE_EVENT, event => {
      const value = event.payload;
      if (!disposed && (value === 'system' || value === 'en' || value === 'zh-CN')) {
        setLanguagePreference(value, false);
      }
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; })
      .catch(error => console.error('LocalView could not listen for language changes:', error));
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener(LANGUAGE_PREFERENCE_EVENT, broadcast);
    };
  }, []);
}
