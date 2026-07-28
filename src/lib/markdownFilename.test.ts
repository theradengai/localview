import { describe, expect, it } from 'vitest';
import cases from '../test/fixtures/markdown-filename-cases.json';
import {
  MARKDOWN_NAME_TOO_LONG,
  MAX_MARKDOWN_FILENAME_UTF16_UNITS,
  normalizeMarkdownFileName,
} from './markdownFilename';

describe('normalizeMarkdownFileName', () => {
  it('matches the shared Rust and TypeScript filename contract', () => {
    for (const testCase of cases) {
      if ('expected' in testCase) {
        expect(normalizeMarkdownFileName(testCase.input), testCase.input).toBe(testCase.expected);
      } else {
        expect(() => normalizeMarkdownFileName(testCase.input), testCase.input).toThrow(testCase.error);
      }
    }
  });

  it('counts the final name in UTF-16 units after adding the suffix', () => {
    expect(MAX_MARKDOWN_FILENAME_UTF16_UNITS).toBe(255);
    expect(normalizeMarkdownFileName('a'.repeat(252))).toHaveLength(255);
    expect(() => normalizeMarkdownFileName('😀'.repeat(127))).toThrow(MARKDOWN_NAME_TOO_LONG);
  });

  it('trims the explicit White_Space set without stripping FEFF', () => {
    expect(normalizeMarkdownFileName('\u0085notes\u3000')).toBe('notes.md');
    expect(normalizeMarkdownFileName('\ufeffnotes')).toBe('\ufeffnotes.md');
  });
});
