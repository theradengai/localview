import { useSyncExternalStore } from 'react';
import { getLanguagePreference, getLanguageSnapshot, getLocale, subscribeLanguage, t } from './i18n';

export function useI18n() {
  useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, getLanguageSnapshot);
  return { locale: getLocale(), preference: getLanguagePreference(), t };
}
