import { describe, expect, it } from 'vitest';
import cases from '../test/fixtures/directory-name-cases.json';
import {
  DIRECTORY_NAME_TOO_LONG,
  MAX_DIRECTORY_NAME_UTF16_UNITS,
  normalizeDirectoryName,
} from './directoryName';

describe('normalizeDirectoryName', () => {
  it('matches the shared Rust and TypeScript directory-name contract', () => {
    for (const testCase of cases) {
      if ('expected' in testCase) {
        expect(normalizeDirectoryName(testCase.input), testCase.input).toBe(testCase.expected);
      } else {
        expect(() => normalizeDirectoryName(testCase.input), testCase.input).toThrow(testCase.error);
      }
    }
  });

  it('counts the final directory name in UTF-16 units', () => {
    expect(MAX_DIRECTORY_NAME_UTF16_UNITS).toBe(255);
    expect(normalizeDirectoryName('a'.repeat(255))).toHaveLength(255);
    expect(() => normalizeDirectoryName('😀'.repeat(128))).toThrow(DIRECTORY_NAME_TOO_LONG);
  });

  it('allows ordinary hidden folders but rejects names hidden from LocalView refresh', () => {
    expect(normalizeDirectoryName('.config')).toBe('.config');
    expect(() => normalizeDirectoryName('.draft.localview-1.tmp')).toThrow('DIRECTORY_NAME_RESERVED');
  });
});
