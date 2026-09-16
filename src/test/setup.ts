import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { setLanguagePreference } from '../lib/i18n';

// The original fixtures describe macOS. Pin their browser platform independently
// of the CI host; Windows-specific tests explicitly stub these same getters.
// Do this before test modules load so CodeMirror detects the fixture platform too.
function resetFixturePlatform(): void {
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  });
}
resetFixturePlatform();

beforeEach(() => {
  resetFixturePlatform();
  setLanguagePreference('zh-CN');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
