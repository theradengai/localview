import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_GFM_EXTENSION,
  findTopLevelGfmTableRange,
} from './markdownLanguage';

function stateFor(doc: string) {
  return EditorState.create({ doc, extensions: [MARKDOWN_GFM_EXTENSION] });
}

describe('findTopLevelGfmTableRange', () => {
  it('finds one top-level GFM table from every meaningful insertion boundary', () => {
    const table = [
      '| A | B |',
      '| --- | --- |',
      '| x | y |',
    ].join('\n');
    const source = `${table}\n\nafter`;
    const state = stateFor(source);
    const expected = { from: 0, to: table.length };

    expect(findTopLevelGfmTableRange(state, 0)).toEqual(expected);
    expect(findTopLevelGfmTableRange(state, source.indexOf('---'))).toEqual(expected);
    expect(findTopLevelGfmTableRange(state, source.indexOf('y'))).toEqual(expected);
    expect(findTopLevelGfmTableRange(state, table.length)).toEqual(expected);
    expect(findTopLevelGfmTableRange(state, table.length + 1)).toBeNull();
    expect(findTopLevelGfmTableRange(state, source.indexOf('after'))).toBeNull();
  });

  it('supports a top-level table without outer pipes', () => {
    const table = 'A | B\n--- | ---\nx | y';
    expect(findTopLevelGfmTableRange(stateFor(table), table.indexOf('y')))
      .toEqual({ from: 0, to: table.length });
  });

  it('fails closed for fenced, list, blockquote, and HTML block tables', () => {
    const fenced = ['```', '', '| A | B |', '| --- | --- |', '| x | y |', '```'].join('\n');
    expect(findTopLevelGfmTableRange(stateFor(fenced), fenced.indexOf('x'))).toBeNull();

    const list = ['- item', '  | A | B |', '  | --- | --- |', '  | x | y |'].join('\n');
    expect(findTopLevelGfmTableRange(stateFor(list), list.indexOf('x'))).toBeNull();

    const quote = ['> | A | B |', '> | --- | --- |', '> | x | y |'].join('\n');
    expect(findTopLevelGfmTableRange(stateFor(quote), quote.indexOf('x'))).toBeNull();

    const html = ['<div>', '| A | B |', '| --- | --- |', '| x | y |', '</div>'].join('\n');
    expect(findTopLevelGfmTableRange(stateFor(html), html.indexOf('x'))).toBeNull();
  });

  it('rejects invalid positions and a ragged GFM table remains a single range for strict parsing', () => {
    const table = ['| A | B |', '| --- | --- |', '| x | y |', 'ragged'].join('\n');
    const state = stateFor(table);
    expect(findTopLevelGfmTableRange(state, -1)).toBeNull();
    expect(findTopLevelGfmTableRange(state, table.length + 1)).toBeNull();
    expect(findTopLevelGfmTableRange(state, table.indexOf('ragged')))
      .toEqual({ from: 0, to: table.length });
  });
});
