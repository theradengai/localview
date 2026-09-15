import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { setLanguagePreference } from '../lib/i18n';

// Existing fixtures assert Chinese labels. Locale tests explicitly override this.
beforeEach(() => { setLanguagePreference('zh-CN'); });

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
