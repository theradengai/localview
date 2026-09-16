import { afterEach, describe, expect, it, vi } from 'vitest';
import { htmlPreviewPolicy, platformMessage } from './platform';
import { t, setLanguagePreference } from './i18n';
import { assetUrl, previewAssetUrl } from './desktop';
afterEach(() => { vi.restoreAllMocks(); delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__; });
function windows() { vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0'); }
describe('Windows UI and preview boundaries', () => {
  it('uses the mapped local protocol but never arbitrary external connections', () => {
    windows(); expect(htmlPreviewPolicy()).toContain('http://localview.localhost');
    expect(htmlPreviewPolicy()).toContain("connect-src 'none'");
    expect(htmlPreviewPolicy()).not.toContain('https:');
    expect(htmlPreviewPolicy()).not.toContain('*');
  });
  it('changes application terminology, not interpolation values', () => {
    windows();setLanguagePreference('en');
    expect(platformMessage('Reveal in Finder · ⌘S')).toBe('Reveal in File Explorer · Ctrl+S');
    expect(t('在 Finder 中显示')).toBe('Reveal in File Explorer');
    expect(t('{0} 个文件', 'Finder')).toContain('Finder');
  });
  it('serves the first filename character under a drive root and scopes resources', () => {
    windows();(window as unknown as Record<string,unknown>).__TAURI_INTERNALS__ = {};
    expect(assetUrl('C:/测试.png','C:/','scope')).toBe('http://localview.localhost/asset/scope/%E6%B5%8B%E8%AF%95.png');
    expect(previewAssetUrl('\\\\?\\C:\\Docs\\x.css','C:/Docs','token')).toBe('http://localview.localhost/preview/token/x.css');
    expect(() => assetUrl('D:/x.png','C:/','scope')).toThrow();
  });
});
