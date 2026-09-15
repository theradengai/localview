import english from './locales/en.json';

export type Locale = 'zh-CN' | 'en';
export type LanguagePreference = 'system' | Locale;
export const LANGUAGE_STORAGE_KEY = 'localview.language';
export const LANGUAGE_PREFERENCE_EVENT = 'localview-language-preference';
const messages: Readonly<Record<string, string>> = english;
const listeners = new Set<() => void>();

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return value === 'en' || value === 'zh-CN' ? value : 'system';
}

export function resolveLocale(preference: LanguagePreference, languages: readonly string[]): Locale {
  if (preference !== 'system') return preference;
  for (const language of languages) {
    if (/^zh(?:[-_]|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:[-_]|$)/i.test(language)) return 'en';
  }
  return 'en';
}

function readPreference(): LanguagePreference {
  try { return normalizeLanguagePreference(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)); }
  catch { return 'system'; }
}

let preference = readPreference();
export function getLanguagePreference(): LanguagePreference { return preference; }
export function getLocale(): Locale {
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages?.length
    ? navigator.languages : [navigator.language];
  return resolveLocale(preference, languages);
}

// A primitive snapshot stays referentially stable until the actual setting changes.
export function getLanguageSnapshot(): string { return `${preference}:${getLocale()}`; }
function notify(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = getLocale();
  listeners.forEach(listener => listener());
}
export function setLanguagePreference(value: LanguagePreference, broadcast = true): void {
  preference = normalizeLanguagePreference(value);
  try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference); }
  catch { /* Keep the selection for this window even when storage is unavailable. */ }
  notify();
  if (broadcast && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LANGUAGE_PREFERENCE_EVENT, { detail: preference }));
  }
}
function storageChanged(event: StorageEvent): void {
  if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
  // Session storage must never change the application preference.
  try { if (event.storageArea && event.storageArea !== window.localStorage) return; }
  catch { /* Some WebViews block storage access. The bounded payload is still safe. */ }
  preference = event.key === null ? 'system' : normalizeLanguagePreference(event.newValue);
  notify();
}
function systemLanguageChanged(): void { if (preference === 'system') notify(); }
export function subscribeLanguage(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('storage', storageChanged);
    window.addEventListener('languagechange', systemLanguageChanged);
  }
  listeners.add(listener);
  if (typeof document !== 'undefined') document.documentElement.lang = getLocale();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener('languagechange', systemLanguageChanged);
    }
  };
}

/** Translate application-owned messages only. Values are inserted once, never translated. */
export function t(message: string, ...values: readonly (string | number)[]): string {
  const template = getLocale() === 'en' ? messages[message] ?? message : message;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}
