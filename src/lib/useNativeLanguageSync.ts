import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  getLanguagePreference, getLocale, LANGUAGE_PREFERENCE_EVENT,
  setLanguagePreference, suspendLanguageStorageEvents, type LanguagePreference,
} from './i18n';

const NATIVE_LANGUAGE_EVENT = 'localview-ui-language';
type LanguageSnapshot = { preference: LanguagePreference; revision: number };
function isSnapshot(value: unknown): value is LanguageSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<LanguageSnapshot>;
  return ['system', 'en', 'zh-CN'].includes(snapshot.preference ?? '')
    && Number.isSafeInteger(snapshot.revision) && snapshot.revision! >= 0;
}

/** The native process orders changes. Receiving windows never rebroadcast them. */
export function useNativeLanguageSync() {
  useEffect(() => {
    if (!isTauri()) return;
    const resumeStorageEvents = suspendLanguageStorageEvents();
    let disposed = false;
    let stop: (() => void) | undefined;
    let latest: LanguageSnapshot | undefined;
    let pending = 0;
    let lastWriteSucceeded = true;
    const report = (error: unknown) => console.error('LocalView language synchronization failed:', error);
    const apply = (value: unknown) => {
      if (disposed || !isSnapshot(value) || (latest && value.revision < latest.revision)) return;
      latest = value;
      if (pending > 0 || !lastWriteSucceeded) return;
      setLanguagePreference(value.preference, false);
      // The backend checks this revision again at the menu mutation boundary.
      void invoke('set_ui_language', { request: {
        action: 'menu', language: getLocale(), revision: value.revision,
      } }).catch(report);
    };
    const initialPreference = getLanguagePreference();
    let writes: Promise<unknown> = listen<unknown>(NATIVE_LANGUAGE_EVENT, event => apply(event.payload))
      .then(unlisten => {
        if (disposed) { unlisten(); return; }
        stop = unlisten;
        return invoke('set_ui_language', { request: {
          action: 'initialize', preference: initialPreference,
        } }).then(apply);
      }).catch(report);
    const broadcast = (event: Event) => {
      const preference = (event as CustomEvent<LanguagePreference>).detail;
      if (!['system', 'en', 'zh-CN'].includes(preference)) return;
      pending += 1;
      // Serialize writes from this window so a rapid A → B → A is not reordered.
      writes = writes.catch(report).then(async () => {
        if (disposed) return;
        try {
          const value = await invoke('set_ui_language', { request: { action: 'select', preference } });
          lastWriteSucceeded = true;
          apply(value);
        } catch (error) {
          lastWriteSucceeded = false;
          report(error);
        } finally {
          pending -= 1;
          if (!disposed && pending === 0 && latest) apply(latest);
        }
      });
    };
    const systemChanged = () => { if (latest?.preference === 'system') apply(latest); };
    window.addEventListener(LANGUAGE_PREFERENCE_EVENT, broadcast);
    window.addEventListener('languagechange', systemChanged);
    return () => {
      disposed = true;
      stop?.();
      resumeStorageEvents();
      window.removeEventListener(LANGUAGE_PREFERENCE_EVENT, broadcast);
      window.removeEventListener('languagechange', systemChanged);
    };
  }, []);
}
