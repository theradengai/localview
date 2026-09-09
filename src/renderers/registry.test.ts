import { describe, expect, it } from 'vitest';
import type { DesktopEntry, FileKind } from '../lib/desktop';
import { rendererFor } from './registry';

function entry(name: string, kind: FileKind): DesktopEntry {
  return { name, kind, path: `/workspace/${name}` };
}

describe('rendererFor', () => {
  it.each([
    ['notes.md', 'md', 'markdown'],
    ['index.html', 'html', 'html'],
    ['notes.txt', 'text', 'text'],
    ['cover.png', 'image', 'image'],
    ['manual.pdf', 'pdf', 'pdf'],
    ['contacts.csv', 'spreadsheet', 'spreadsheet-grid'],
    ['EXPORT.CSV', 'spreadsheet', 'spreadsheet-grid'],
    ['budget.xlsx', 'spreadsheet', 'spreadsheet-grid'],
    ['legacy.XLS', 'spreadsheet', 'spreadsheet-grid'],
    ['portable.ods', 'spreadsheet', 'spreadsheet-grid'],
    ['native.numbers', 'spreadsheet', 'system-preview'],
    ['draft.pages', 'document', 'system-preview'],
    ['letter.docx', 'document', 'system-preview'],
    ['slides.pptx', 'presentation', 'system-preview'],
    ['deck.key', 'presentation', 'system-preview'],
    ['binary.bin', 'other', 'unsupported'],
  ] as const)('maps %s to %s', (name, kind, renderer) => {
    expect(rendererFor(entry(name, kind))).toBe(renderer);
  });
});
