import { EditorState } from '@codemirror/state';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import {
  applyMarkdownCommand,
  getMarkdownCommandAvailability,
  inspectMarkdownInlineStyleSelection,
  parseEditableGfmTableRange,
  normalizeMarkdownLinkUrl,
  serializeGfmTable,
  type MarkdownCommand,
  type MarkdownCommandArgument,
  type MarkdownCommandContext,
  type MarkdownSelection,
} from './markdownEditing';
import {
  findTopLevelGfmTableRange,
  MARKDOWN_GFM_EXTENSION,
} from './markdownLanguage';

const TABLE_MAX_BYTES = 64 * 1024;

function contextFor(
  source: string,
  selection: MarkdownSelection,
  contextPosition = selection.head,
  selectionCount = 1,
): MarkdownCommandContext {
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  const state = EditorState.create({ doc: source, extensions: [MARKDOWN_GFM_EXTENSION] });
  const range = findTopLevelGfmTableRange(state, contextPosition);
  const table = range
    ? parseEditableGfmTableRange(state.sliceDoc(range.from, range.to), range.from, contextPosition)
    : null;
  return {
    selection,
    selectionCount,
    selectedText: source.slice(from, to),
    contextPosition,
    table,
    inlineStyle: inspectMarkdownInlineStyleSelection(source, selection),
  };
}

function run(
  source: string,
  selection: MarkdownSelection,
  command: MarkdownCommand,
  argument?: MarkdownCommandArgument,
  contextPosition = selection.head,
) {
  const result = applyMarkdownCommand({
    source,
    ...contextFor(source, selection, contextPosition),
    command,
    argument,
  });
  if (!result) return null;
  return {
    ...result,
    source: source.slice(0, result.change.from)
      + result.change.insert
      + source.slice(result.change.to),
  };
}

function markdownAst(source: string) {
  const processor = unified().use(remarkParse).use(remarkGfm);
  return processor.runSync(processor.parse(source));
}

function oneColumnTable(rows: number, cell = 'x') {
  return ['| A |', '| --- |', ...Array.from({ length: rows }, () => `| ${cell} |`)].join('\n');
}

function manyColumnTable(columns: number) {
  const headers = Array.from({ length: columns }, (_, index) => `H${index + 1}`);
  return [
    `| ${headers.join(' | ')} |`,
    `| ${Array(columns).fill('---').join(' | ')} |`,
    `| ${Array(columns).fill('x').join(' | ')} |`,
  ].join('\n');
}

describe('Markdown inline editing', () => {
  it('wraps and unwraps inline styles while preserving reversed selections', () => {
    const wrapped = run('hello', { anchor: 5, head: 0 }, 'bold');
    expect(wrapped?.source).toBe('**hello**');
    expect(wrapped?.selection).toEqual({ anchor: 7, head: 2 });
    expect(run(wrapped!.source, wrapped!.selection, 'bold')?.source).toBe('hello');

    expect(run('hello', { anchor: 0, head: 5 }, 'italic')?.source).toBe('*hello*');
    expect(run('hello', { anchor: 0, head: 5 }, 'strikethrough')?.source).toBe('~~hello~~');
    expect(run('hello', { anchor: 2, head: 2 }, 'italic')?.selection)
      .toEqual({ anchor: 3, head: 3 });
  });

  it('uses a safe inline-code delimiter and unwraps its own padding', () => {
    const wrapped = run('a`b', { anchor: 0, head: 3 }, 'inlineCode');
    expect(wrapped?.source).toBe('``a`b``');
    expect(run(wrapped!.source, wrapped!.selection, 'inlineCode')?.source).toBe('a`b');

    const padded = run('`a`', { anchor: 0, head: 3 }, 'inlineCode');
    expect(padded?.source).toBe('`` `a` ``');
    expect(run(padded!.source, padded!.selection, 'inlineCode')?.source).toBe('`a`');
  });

  it.each([
    ['italic', '\\*literal*', 2, 9],
    ['bold', '\\**literal**', 3, 10],
    ['strikethrough', '\\~~literal~~', 3, 10],
    ['inlineCode', '\\`literal`', 2, 9],
  ] as const)('fails closed for escaped adjacent %s markers', (command, source, from, to) => {
    const before = markdownAst(source);
    const result = run(source, { anchor: from, head: to }, command);
    const afterSource = result?.source ?? source;
    expect(result).toBeNull();
    expect(afterSource).toBe(source);
    expect(markdownAst(afterSource)).toEqual(before);
  });

  it('disables inline commands for multiline and all commands for multiple selections', () => {
    const multiline = getMarkdownCommandAvailability(contextFor(
      'one\ntwo',
      { anchor: 0, head: 7 },
    ));
    expect(multiline.bold).toBe(false);
    expect(multiline.highlight).toBe(false);
    expect(multiline.fontColor).toBe(false);
    expect(multiline.codeBlock).toBe(true);

    const multiple = getMarkdownCommandAvailability(contextFor(
      'one',
      { anchor: 0, head: 3 },
      3,
      2,
    ));
    expect(Object.values(multiple).every((value) => value === false)).toBe(true);
  });

  it('toggles highlight and changes or removes a fixed font color in one change', () => {
    const highlighted = run('hello', { anchor: 5, head: 0 }, 'highlight');
    expect(highlighted?.source).toBe('<mark>hello</mark>');
    expect(highlighted?.selection).toEqual({ anchor: 11, head: 6 });
    expect(run(highlighted!.source, highlighted!.selection, 'highlight')?.source).toBe('hello');

    const blue = run('hello', { anchor: 0, head: 5 }, 'fontColor', { color: 'blue' });
    expect(blue?.source).toBe('<span data-localview-color="blue">hello</span>');
    const purple = run(blue!.source, blue!.selection, 'fontColor', { color: 'purple' });
    expect(purple?.source).toBe('<span data-localview-color="purple">hello</span>');
    expect(run(purple!.source, purple!.selection, 'fontColor', { color: null })?.source)
      .toBe('hello');
    expect(run(blue!.source, blue!.selection, 'fontColor', { color: 'blue' })).toBeNull();
  });

  it('allows highlight and color nesting but fails closed on same-style partial ranges', () => {
    const colored = run('**bold**', { anchor: 0, head: 8 }, 'fontColor', { color: 'red' });
    expect(colored?.source).toBe('<span data-localview-color="red">**bold**</span>');
    const nested = run(colored!.source, colored!.selection, 'highlight');
    expect(nested?.source).toBe(
      '<span data-localview-color="red"><mark>**bold**</mark></span>',
    );

    expect(run('<mark>hello</mark>', { anchor: 7, head: 10 }, 'highlight')).toBeNull();
    const colorSource = '<span data-localview-color="green">hello</span>';
    expect(run(colorSource, { anchor: 39, head: 42 }, 'fontColor', { color: 'blue' })).toBeNull();
    expect(run('one\ntwo', { anchor: 0, head: 7 }, 'highlight')).toBeNull();
    expect(run('hello', { anchor: 0, head: 5 }, 'fontColor', { color: 'pink' as 'red' })).toBeNull();
  });
});

describe('Markdown block editing and links', () => {
  it('covers heading levels and paragraph normalization', () => {
    expect(run('Title', { anchor: 0, head: 5 }, 'heading1')?.source).toBe('# Title');
    expect(run('Title', { anchor: 0, head: 5 }, 'heading2')?.source).toBe('## Title');
    const heading3 = run('## Title', { anchor: 3, head: 8 }, 'heading3');
    expect(heading3?.source).toBe('### Title');
    expect(run(heading3!.source, heading3!.selection, 'paragraph')?.source).toBe('Title');
  });

  it('covers blockquote, code block, and every list branch', () => {
    const quoted = run('one\n\ntwo', { anchor: 0, head: 8 }, 'blockquote');
    expect(quoted?.source).toBe('> one\n\n> two');
    expect(run(quoted!.source, quoted!.selection, 'blockquote')?.source).toBe('one\n\ntwo');

    const source = 'before\nconst ticks = ```;\nafter';
    const code = run(source, {
      anchor: source.indexOf('const'),
      head: source.indexOf('\nafter'),
    }, 'codeBlock');
    expect(code?.source).toContain('\n\n````\nconst ticks = ```;\n````\n\nafter');

    const input = '- one\n* two\n\nthree';
    expect(run(input, { anchor: 0, head: input.length }, 'unorderedList')?.source)
      .toBe('- one\n- two\n\n- three');
    const ordered = run(input, { anchor: 0, head: input.length }, 'orderedList');
    expect(ordered?.source).toBe('1. one\n2. two\n\n3. three');
    expect(run(ordered!.source, ordered!.selection, 'taskList')?.source)
      .toBe('- [ ] one\n- [ ] two\n\n- [ ] three');
    expect(run(ordered!.source, ordered!.selection, 'clearList')?.source)
      .toBe('one\ntwo\n\nthree');
    expect(run('plain', { anchor: 0, head: 5 }, 'clearList')).toBeNull();
  });

  it('escapes link destinations and labels with exact selection mapping', () => {
    const label = 'a\\b[c]中文🙂';
    const result = run(label, { anchor: 0, head: label.length }, 'link', {
      url: 'docs/my file(1).md',
    });
    const escaped = 'a\\\\b\\[c\\]中文🙂';
    expect(result?.source).toBe(`[${escaped}](docs/my%20file\\(1\\).md)`);
    expect(result?.source.slice(result.selection.anchor, result.selection.head)).toBe(escaped);
    expect(markdownAst(result!.source)).toMatchObject({
      children: [{ type: 'paragraph' }],
    });
    expect(run('x', { anchor: 0, head: 1 }, 'link', { url: 'bad\nurl' })).toBeNull();
    expect(normalizeMarkdownLinkUrl('  docs/page.md  ')).toBe('docs/page.md');
    expect(normalizeMarkdownLinkUrl('')).toBeNull();
    expect(normalizeMarkdownLinkUrl('bad\u0000url')).toBeNull();
  });
});

describe('strict GFM table parsing and limits', () => {
  it('parses alignments, optional pipes, escaped pipes, code spans, CJK, and trailing whitespace', () => {
    const source = [
      '| 名称 | 内容 | 代码 |   ',
      '| :--- | :---: | ---: |\t',
      '| A | 左\\|右 | `x|y` |  ',
      '| B | 中文 | ok |',
    ].join('\n');
    const model = parseEditableGfmTableRange(source, 0, source.indexOf('中文'));
    expect(model).toMatchObject({
      headers: ['名称', '内容', '代码'],
      alignments: ['left', 'center', 'right'],
      currentRow: 1,
      currentColumn: 1,
    });
    expect(serializeGfmTable(model!)).toContain('| A | 左\\|右 | `x|y` |');

    const withoutOuter = 'A | B\n--- | ---\none | two';
    expect(parseEditableGfmTableRange(withoutOuter, 10, 10 + withoutOuter.indexOf('two'))?.headers)
      .toEqual(['A', 'B']);
  });

  it('handles consecutive backslash parity and rejects malformed or partially consumed ranges', () => {
    const even = '| A | B | C |\n| --- | --- | --- |\n| one\\\\ | two | three |';
    expect(parseEditableGfmTableRange(even, 0, even.indexOf('three'))?.rows[0])
      .toEqual(['one\\\\', 'two', 'three']);

    const malformed = '| A | B |\n| --- | nope |\n| one | two |';
    const inconsistent = '| A | B |\n| --- | --- |\n| only |';
    const prefix = '| A | B |\n | --- | --- |\n| one | two |';
    const unclosed = '| A | B |\n| --- | --- |\n| `one | two |';
    const extra = '| A | B |\n| --- | --- |\n| one | two |\n';
    for (const source of [malformed, inconsistent, prefix, unclosed, extra]) {
      expect(parseEditableGfmTableRange(source, 0, Math.min(source.length, source.indexOf('one'))))
        .toBeNull();
    }
  });

  it('accepts exact row, column, and UTF-8 limits and rejects one over', () => {
    const rows200 = oneColumnTable(200);
    expect(parseEditableGfmTableRange(rows200, 0, rows200.lastIndexOf('x'))?.rows).toHaveLength(200);
    const rows201 = oneColumnTable(201);
    expect(parseEditableGfmTableRange(rows201, 0, rows201.lastIndexOf('x'))).toBeNull();

    const columns50 = manyColumnTable(50);
    expect(parseEditableGfmTableRange(columns50, 0, columns50.lastIndexOf('x'))?.headers)
      .toHaveLength(50);
    const columns51 = manyColumnTable(51);
    expect(parseEditableGfmTableRange(columns51, 0, columns51.lastIndexOf('x'))).toBeNull();

    const base = oneColumnTable(1, '');
    const exact = oneColumnTable(1, 'x'.repeat(TABLE_MAX_BYTES - base.length));
    expect(new TextEncoder().encode(exact)).toHaveLength(TABLE_MAX_BYTES);
    expect(parseEditableGfmTableRange(exact, 0, exact.lastIndexOf('x'))).not.toBeNull();
    const over = `${exact}x`;
    expect(parseEditableGfmTableRange(over, 0, over.lastIndexOf('x'))).toBeNull();
  });

  it('disables add operations at every generation limit', () => {
    const rows = oneColumnTable(200);
    const rowAvailability = getMarkdownCommandAvailability(contextFor(
      rows,
      { anchor: rows.lastIndexOf('x'), head: rows.lastIndexOf('x') },
    ));
    expect(rowAvailability.tableAddRowAbove).toBe(false);
    expect(rowAvailability.tableAddRowBelow).toBe(false);

    const columns = manyColumnTable(50);
    const columnAvailability = getMarkdownCommandAvailability(contextFor(
      columns,
      { anchor: columns.lastIndexOf('x'), head: columns.lastIndexOf('x') },
    ));
    expect(columnAvailability.tableAddColumnLeft).toBe(false);
    expect(columnAvailability.tableAddColumnRight).toBe(false);

    const base = oneColumnTable(1, '');
    const exactBytes = oneColumnTable(1, 'x'.repeat(TABLE_MAX_BYTES - base.length));
    const byteContext = contextFor(exactBytes, {
      anchor: exactBytes.lastIndexOf('x'),
      head: exactBytes.lastIndexOf('x'),
    });
    expect(getMarkdownCommandAvailability(byteContext).tableAddRowBelow).toBe(false);
    expect(applyMarkdownCommand({ ...byteContext, command: 'tableAddRowBelow' })).toBeNull();
  });
});

describe('GFM table insertion and structural commands', () => {
  const table = [
    '| Name | Value |',
    '| :--- | ---: |',
    '| A | 1 |',
    '| B | 2 |',
  ].join('\n');

  it.each([
    [{ columns: Number.NaN, rows: 2 }, null],
    [{ columns: Number.POSITIVE_INFINITY, rows: 2 }, null],
    [{ columns: 2, rows: Number.NEGATIVE_INFINITY }, null],
    [{ columns: -4, rows: 0 }, { columns: 1, rows: 1 }],
    [{ columns: 2.9, rows: 3.8 }, { columns: 2, rows: 3 }],
    [{ columns: 99, rows: 99 }, { columns: 8, rows: 8 }],
  ])('validates and clamps insert-table dimensions %#', (argument, expected) => {
    const result = run('', { anchor: 0, head: 0 }, 'insertTable', argument);
    if (!expected) {
      expect(result).toBeNull();
      return;
    }
    const parsed = parseEditableGfmTableRange(result!.source, 0, 0);
    expect(parsed?.headers).toHaveLength(expected.columns);
    expect(parsed?.rows).toHaveLength(expected.rows);
  });

  it('inserts on blank and non-empty lines without overwriting content', () => {
    const blank = run('before\n\nlater', { anchor: 7, head: 7 }, 'insertTable', {
      columns: 3,
      rows: 2,
    });
    expect(blank?.source).toContain('before\n\n| 列 1 | 列 2 | 列 3 |');
    expect(blank?.source).toContain('|  |  |  |\n\nlater');
    expect(blank?.source.slice(blank.selection.anchor, blank.selection.head)).toBe('列 1');
    expect(contextFor(blank!.source, blank!.selection).table).not.toBeNull();

    const nonEmpty = run('paragraph\nnext', { anchor: 4, head: 4 }, 'insertTable', {
      columns: 1,
      rows: 1,
    });
    expect(nonEmpty?.source).toBe('paragraph\n\n| 列 1 |\n| --- |\n|  |\n\nnext');
  });

  it('covers add/delete row branches and their minimum boundary', () => {
    const caret = table.indexOf('A');
    expect(run(table, { anchor: caret, head: caret }, 'tableAddRowAbove')?.source)
      .toContain('|  |  |\n| A | 1 |');
    const addedBelow = run(table, { anchor: caret, head: caret }, 'tableAddRowBelow');
    expect(addedBelow?.source).toContain('| A | 1 |\n|  |  |\n| B | 2 |');
    expect(run(table, { anchor: caret, head: caret }, 'tableDeleteRow')?.source)
      .not.toContain('| A | 1 |');

    const single = oneColumnTable(1, 'one');
    const availability = getMarkdownCommandAvailability(contextFor(
      single,
      { anchor: single.indexOf('one'), head: single.indexOf('one') },
    ));
    expect(availability.tableDeleteRow).toBe(false);
  });

  it('covers add/delete column and every alignment branch', () => {
    const value = table.indexOf('Value');
    expect(run(table, { anchor: value, head: value }, 'tableAddColumnLeft')?.source)
      .toContain('| Name | 列 2 | Value |');
    expect(run(table, { anchor: value, head: value }, 'tableAddColumnRight')?.source)
      .toContain('| Name | Value | 列 3 |');
    expect(run(table, { anchor: value, head: value }, 'tableDeleteColumn')?.source)
      .toBe('| Name |\n| :--- |\n| A |\n| B |');

    expect(run(table, { anchor: value, head: value }, 'tableAlignNone')?.source)
      .toContain('| :--- | --- |');
    expect(run(table, { anchor: value, head: value }, 'tableAlignLeft')?.source)
      .toContain('| :--- | :--- |');
    expect(run(table, { anchor: value, head: value }, 'tableAlignCenter')?.source)
      .toContain('| :--- | :---: |');
    expect(run(table, { anchor: value, head: value }, 'tableAlignRight')).toBeNull();
  });

  it('deletes the exact table range in one change', () => {
    const caret = table.indexOf('A');
    const result = run(table, { anchor: caret, head: caret }, 'tableDelete');
    expect(result?.source).toBe('');
    expect(result?.change).toEqual({ from: 0, to: table.length, insert: '' });
  });
});
