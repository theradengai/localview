import { describe, expect, it } from 'vitest';
import {
  inspectLocalInlineStyleSelection,
  MARKDOWN_INLINE_STYLE_MAX_CHARACTERS,
  MARKDOWN_INLINE_STYLE_MAX_DEPTH,
  remarkLocalInlineStyles,
  scanLocalInlineStylePairs,
} from './markdownInlineStyles';

type Node = {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: Node[];
};

function paragraph(children: Node[]): Node {
  return { type: 'root', children: [{ type: 'paragraph', children }] };
}

function transform(tree: Node) {
  remarkLocalInlineStyles()(tree);
  return tree;
}

describe('LocalView Markdown inline styles', () => {
  it('strictly pairs nested highlight and fixed color tokens', () => {
    const source = '<mark>one <span data-localview-color="red">two</span></mark>';
    const scan = scanLocalInlineStylePairs(source);
    expect(scan.valid).toBe(true);
    expect(scan.pairs).toMatchObject([
      { kind: 'highlight', contentFrom: 6, contentTo: source.length - 7 },
      { kind: 'color', color: 'red' },
    ]);
  });

  it.each([
    '<mark>open',
    '</mark>',
    '<mark><span data-localview-color="red">cross</mark></span>',
    '<span data-localview-color="pink">unknown</span>',
  ])('fails closed for malformed or unsupported source: %s', (source) => {
    const scan = scanLocalInlineStylePairs(source);
    if (source.includes('pink')) expect(scan).toEqual({ valid: false, pairs: [] });
    else expect(scan.valid).toBe(false);
  });

  it('reports exact and partial selection safety without consuming wrapper tokens', () => {
    const source = '<mark>hello</mark> <span data-localview-color="blue">world</span>';
    const highlight = inspectLocalInlineStyleSelection(source, 6, 11);
    expect(highlight.highlightSafe).toBe(true);
    expect(highlight.directHighlight?.kind).toBe('highlight');
    expect(inspectLocalInlineStyleSelection(source, 7, 10).highlightSafe).toBe(false);

    const worldFrom = source.indexOf('world');
    const color = inspectLocalInlineStyleSelection(source, worldFrom, worldFrom + 5);
    expect(color.colorSafe).toBe(true);
    expect(color.directColor?.color).toBe('blue');
    expect(inspectLocalInlineStyleSelection(source, worldFrom + 1, worldFrom + 4).colorSafe).toBe(false);
  });

  it('converts only exact same-parent nodes and preserves nested Markdown children', () => {
    const tree = paragraph([
      { type: 'html', value: '<mark>' },
      { type: 'text', value: 'bright ' },
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      { type: 'html', value: '</mark>' },
      { type: 'text', value: ' ' },
      { type: 'html', value: '<span data-localview-color="purple">' },
      { type: 'text', value: 'purple' },
      { type: 'html', value: '</span>' },
    ]);
    transform(tree);
    const children = tree.children![0].children!;
    expect(children[0]).toMatchObject({
      type: 'localViewHighlight',
      data: { hName: 'mark' },
      children: [{ type: 'text' }, { type: 'strong' }],
    });
    expect(children[2]).toMatchObject({
      type: 'localViewColor',
      data: { hName: 'span' },
    });
  });

  it('leaves arbitrary, attributed, crossing, and cross-parent HTML untouched', () => {
    const fixtures = [
      paragraph([{ type: 'html', value: '<script>' }, { type: 'text', value: 'x' }, { type: 'html', value: '</script>' }]),
      paragraph([{ type: 'html', value: '<mark class="x">' }, { type: 'text', value: 'x' }, { type: 'html', value: '</mark>' }]),
      paragraph([{ type: 'html', value: '<span style="color:red">' }, { type: 'text', value: 'x' }, { type: 'html', value: '</span>' }]),
      paragraph([{ type: 'html', value: '<mark>' }, { type: 'text', value: 'open' }]),
    ];
    fixtures.forEach((tree) => {
      const before = structuredClone(tree);
      transform(tree);
      expect(tree).toEqual(before);
    });
  });

  it('fails closed beyond the depth and inline-source character budgets', () => {
    const deep = `${'<mark>'.repeat(MARKDOWN_INLINE_STYLE_MAX_DEPTH + 1)}x${'</mark>'.repeat(MARKDOWN_INLINE_STYLE_MAX_DEPTH + 1)}`;
    expect(scanLocalInlineStylePairs(deep).valid).toBe(false);

    const oversizedSource = `<mark>${'x'.repeat(MARKDOWN_INLINE_STYLE_MAX_CHARACTERS + 1)}</mark>`;
    expect(scanLocalInlineStylePairs(oversizedSource).valid).toBe(false);
    const oversizedTree = paragraph([
      { type: 'html', value: '<mark>' },
      { type: 'text', value: 'x'.repeat(MARKDOWN_INLINE_STYLE_MAX_CHARACTERS + 1) },
      { type: 'html', value: '</mark>' },
    ]);
    const before = structuredClone(oversizedTree);
    transform(oversizedTree);
    expect(oversizedTree).toEqual(before);
  });
});
