import { afterEach, describe, expect, it, vi } from 'vitest';
import english from './locales/en.json';
import {
  getLanguagePreference, getLocale, LANGUAGE_STORAGE_KEY, normalizeLanguagePreference,
  resolveLocale, setLanguagePreference, subscribeLanguage, t,
} from './i18n';

afterEach(() => vi.restoreAllMocks());

describe('interface languages', () => {
  it.each([
    [['zh-CN'], 'zh-CN'], [['zh-TW'], 'zh-CN'], [['zh_Hant_HK'], 'zh-CN'],
    [['en-US', 'zh-CN'], 'en'], [['fr', 'zh-CN', 'en'], 'zh-CN'],
    [['de'], 'en'], [[], 'en'],
  ] as const)('resolves supported system languages in priority order: %j', (languages, expected) => {
    expect(resolveLocale('system', languages)).toBe(expected);
  });

  it('keeps an explicit choice independent of system language and validates persisted values', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(normalizeLanguagePreference('unknown')).toBe('system');
    setLanguagePreference('en');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(getLocale()).toBe('en');
  });

  it('updates subscribers and document language from other-window storage events', () => {
    const changed = vi.fn(), stop = subscribeLanguage(changed);
    window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, newValue: 'en' }));
    expect(getLanguagePreference()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(changed).toHaveBeenCalledOnce();
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'zh-CN' }));
    expect(getLocale()).toBe('en');
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, newValue: 'zh-CN' }));
    expect(changed).toHaveBeenCalledOnce();
  });

  it('follows runtime system changes only in system mode', () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
    setLanguagePreference('system');
    const changed = vi.fn(), stop = subscribeLanguage(changed);
    languages.mockReturnValue(['zh-CN']);
    window.dispatchEvent(new Event('languagechange'));
    expect(getLocale()).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    setLanguagePreference('en');
    changed.mockClear();
    window.dispatchEvent(new Event('languagechange'));
    expect(getLocale()).toBe('en');
    expect(changed).not.toHaveBeenCalled();
    stop();
  });

  it('keeps working when persistence is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setLanguagePreference('en')).not.toThrow();
    expect(t('打开文件夹')).toBe('Open folder');
  });

  it('never translates or recursively interpolates user-supplied filenames and text', () => {
    setLanguagePreference('en');
    expect(t('重命名 {0}', '打开文件夹 {1} $&.md')).toBe('Rename 打开文件夹 {1} $&.md');
    expect(t('unknown diagnostic')).toBe('unknown diagnostic');
    expect(t('保存失败：{0}', '<script>文件</script>')).toBe('Could not save: <script>文件</script>');
  });

  it('has complete, nonempty translations with matching numbered placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
    for (const [key, value] of Object.entries(english)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
