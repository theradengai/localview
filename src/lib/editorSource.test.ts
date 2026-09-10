import { ChangeSet } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { applyEditorChanges, editorOffset, normalizeEditorSource } from './editorSource';

describe('editor source line ending mapping', () => {
  it('maps multiple edits around mixed line endings and keeps untouched bytes', () => {
    const source = '😀\r\none\ntwo\rthree\r\nend';
    const text = normalizeEditorSource(source);
    const changes = ChangeSet.of([
      { from: text.indexOf('one'), to: text.indexOf('one') + 3, insert: 'first' },
      { from: text.indexOf('three'), to: text.indexOf('three') + 5, insert: 'third' },
    ], text.length);
    expect(applyEditorChanges(source, changes)).toBe('😀\r\nfirst\ntwo\rthird\r\nend');
    expect(editorOffset(source, source.indexOf('end'))).toBe(text.indexOf('end'));
  });

  it('maps a newline deletion and uses the existing line ending for inserted lines', () => {
    const source = 'a\r\nb\r\nc';
    expect(applyEditorChanges(source, ChangeSet.of({ from: 1, to: 2, insert: '' }, 5))).toBe('ab\r\nc');
    expect(applyEditorChanges(source, ChangeSet.of({ from: 3, insert: '\nnew' }, 5))).toBe('a\r\nb\r\nnew\r\nc');
  });
});
