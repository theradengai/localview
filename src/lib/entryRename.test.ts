import { describe, expect, it } from 'vitest';
import type { DesktopEntry } from './desktop';
import {
  entryRenameCollision,
  normalizeEntryRenameName,
  splitEntryRenameName,
} from './entryRename';

const entry = (name: string, kind: DesktopEntry['kind'] = 'md'): DesktopEntry => ({
  name,
  kind,
  path: `/workspace/${name}`,
});

describe('entryRename', () => {
  it('splits ordinary, multi-extension, dotfile, folder, and iWork names', () => {
    expect(splitEntryRenameName(entry('notes.md'))).toEqual({
      editableName: 'notes', lockedSuffix: '.md', fullName: 'notes.md',
    });
    expect(splitEntryRenameName(entry('archive.tar.gz', 'other'))).toEqual({
      editableName: 'archive.tar', lockedSuffix: '.gz', fullName: 'archive.tar.gz',
    });
    expect(splitEntryRenameName(entry('.env', 'text'))).toEqual({
      editableName: '.env', lockedSuffix: '', fullName: '.env',
    });
    expect(splitEntryRenameName(entry('docs.v2', 'folder'))).toEqual({
      editableName: 'docs.v2', lockedSuffix: '', fullName: 'docs.v2',
    });
    expect(splitEntryRenameName(entry('Budget.numbers', 'spreadsheet')).lockedSuffix)
      .toBe('.numbers');
  });

  it('normalizes names while preserving the locked suffix', () => {
    expect(normalizeEntryRenameName(entry('notes.md'), '  会议记录  ')).toBe('会议记录.md');
    expect(normalizeEntryRenameName(entry('.env', 'text'), ' .config ')).toBe('.config');
    expect(normalizeEntryRenameName(entry('docs', 'folder'), ' 资料.v2 ')).toBe('资料.v2');
    expect(normalizeEntryRenameName(entry('Budget.numbers', 'spreadsheet'), '预算'))
      .toBe('预算.numbers');
  });

  it.each([
    ['', 'RENAME_INVALID_NAME'],
    ['..', 'RENAME_INVALID_NAME'],
    ['a/b', 'RENAME_INVALID_NAME'],
    ['a\\b', 'RENAME_INVALID_NAME'],
    ['a\u0000b', 'RENAME_INVALID_NAME'],
  ])('rejects invalid editable name %j', (value, code) => {
    expect(() => normalizeEntryRenameName(entry('notes.md'), value)).toThrow(code);
  });

  it('rejects reserved names and folder bundle suffixes', () => {
    expect(() => normalizeEntryRenameName(entry('notes', 'text'), '.DS_Store'))
      .toThrow('RENAME_RESERVED_NAME');
    expect(() => normalizeEntryRenameName(entry('notes', 'text'), '.localview-save.tmp'))
      .toThrow('RENAME_RESERVED_NAME');
    expect(() => normalizeEntryRenameName(entry('docs', 'folder'), 'Budget.numbers'))
      .toThrow('RENAME_RESERVED_NAME');
  });

  it('rejects extension changes, unchanged values, case-only names, and long names', () => {
    expect(() => normalizeEntryRenameName(entry('README', 'text'), 'README.txt'))
      .toThrow('RENAME_EXTENSION_CHANGE_UNSUPPORTED');
    expect(() => normalizeEntryRenameName(entry('notes.md'), 'notes'))
      .toThrow('RENAME_UNCHANGED');
    expect(() => normalizeEntryRenameName(entry('notes.md'), 'NOTES'))
      .toThrow('RENAME_CASE_ONLY_UNSUPPORTED');
    expect(() => normalizeEntryRenameName(entry('notes.md'), '😀'.repeat(127)))
      .toThrow('RENAME_NAME_TOO_LONG');
  });

  it('detects a case-insensitive sibling collision while excluding the source', () => {
    const siblings = [entry('notes.md'), entry('Plan.md')];
    expect(entryRenameCollision(siblings, '/workspace/notes.md', 'NOTES.md')).toBe(false);
    expect(entryRenameCollision(siblings, '/workspace/notes.md', 'plan.md')).toBe(true);
  });
});
