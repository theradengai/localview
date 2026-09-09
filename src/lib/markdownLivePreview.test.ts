import { fireEvent, waitFor } from '@testing-library/react';
import { Compartment } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { EditorState, EditorView } from '@uiw/react-codemirror';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MARKDOWN_GFM_EXTENSION } from './markdownLanguage';
import {
  MARKDOWN_LIVE_PREVIEW_LIMITS,
  createMarkdownLivePreviewExtension,
  flushActiveMarkdownTableCell,
  getActiveMarkdownTableCell,
} from './markdownLivePreview';

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function rect(left = 0, top = 0, width = 800, height = 600): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mountLiveEditor(
  doc: string,
  selection = doc.length,
  options: { editable?: boolean; resolveImageSource?: (source: string) => string } = {},
) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const updates: string[] = [];
  const transactions: Array<{ docChanged: boolean }> = [];
  const editableCompartment = new Compartment();
  const state = EditorState.create({
    doc,
    selection: { anchor: selection },
    extensions: [
      MARKDOWN_GFM_EXTENSION,
      history(),
      editableCompartment.of(EditorView.editable.of(options.editable ?? true)),
      createMarkdownLivePreviewExtension({
        resolveImageSource: options.resolveImageSource ?? ((source) => source),
      }),
      EditorView.updateListener.of((update) => {
        update.transactions.forEach((transaction) => {
          transactions.push({ docChanged: !transaction.changes.empty });
        });
        if (update.docChanged) updates.push(update.state.doc.toString());
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    parent,
    transactions,
    updates,
    view,
    setEditable(editable: boolean) {
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(editable)),
      });
    },
    destroy() {
      view.destroy();
      parent.remove();
    },
  };
}

async function flushLiveBlockRefresh() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => queueMicrotask(resolve));
  });
}

type CapturedMeasure = {
  key?: unknown;
  read: (view: EditorView) => unknown;
  write: (value: unknown, view: EditorView) => void;
};

function captureLiveBlockMeasure() {
  const requests: Array<{ request: CapturedMeasure; view: EditorView }> = [];
  const spy = vi.spyOn(EditorView.prototype, 'requestMeasure').mockImplementation(function capture(
    this: EditorView,
    request,
  ) {
    if (request
      && typeof request.read === 'function'
      && typeof request.write === 'function') {
      requests.push({ request: request as CapturedMeasure, view: this });
    }
  });
  return { requests, spy };
}

describe('Markdown Live Preview decorations', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect());
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => ({
      0: rect(),
      length: 1,
      item: () => rect(),
      [Symbol.iterator]: function* iterator() { yield rect(); },
    } as DOMRectList));
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(),
    });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => ({
        0: rect(),
        length: 1,
        item: () => rect(),
        [Symbol.iterator]: function* iterator() { yield rect(); },
      } as DOMRectList),
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    delete (Range.prototype as Partial<Range>).getClientRects;
  });

  it('styles supported GFM constructs and hides only inactive syntax markers', () => {
    const source = '# Heading\n\nA **bold** and *italic* with ~~strike~~ and `code` plus [link](docs/a.md).';
    const editor = mountLiveEditor(source);
    expect(editor.view.dom.dataset.markdownLivePreview).toBe('true');
    expect(editor.parent.querySelector('.cm-live-heading-1')).toBeTruthy();
    expect(editor.parent.querySelector('.cm-live-strong')).toBeTruthy();
    expect(editor.parent.querySelector('.cm-live-emphasis')).toBeTruthy();
    expect(editor.parent.querySelector('.cm-live-strikethrough')).toBeTruthy();
    expect(editor.parent.querySelector('.cm-live-inline-code')).toBeTruthy();
    expect(editor.parent.querySelector('.cm-live-link')).toBeTruthy();
    expect(editor.view.dom.textContent).not.toContain('**bold**');
    expect(editor.view.state.doc.toString()).toBe(source);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('keeps ordinary list bullets and ordered numbering visible but tasks have only a checkbox', () => {
    const source = '- first\n  - nested\n\n3. third\n1. fourth\n\n- [ ] task\n  - [x] done\n\nafter';
    const editor = mountLiveEditor(source);
    const markers = Array.from(editor.parent.querySelectorAll('.cm-live-list-marker'));
    expect(markers.map((marker) => marker.textContent)).toEqual(['•', '•', '3.', '4.']);
    expect(editor.parent.querySelectorAll('.cm-live-task-checkbox')).toHaveLength(2);
    expect(editor.view.state.doc.toString()).toBe(source);
    expect(editor.updates).toHaveLength(0);
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(editor.parent.querySelector('.cm-line')?.textContent).toBe('- first');
    editor.destroy();
  });

  it('renders setext headings and hides hard-break escapes without changing the source', () => {
    const source = 'Heading\n===\n\nSubheading\n---\n\nfirst\\\nsecond\n\nafter';
    const editor = mountLiveEditor(source);
    expect(editor.parent.querySelector('.cm-live-heading-1')?.textContent).toBe('Heading');
    expect(editor.parent.querySelector('.cm-live-heading-2')?.textContent).toBe('Subheading');
    expect(editor.view.dom.textContent).not.toContain('===');
    expect(editor.view.dom.textContent).not.toContain('first\\');
    expect(editor.view.state.doc.toString()).toBe(source);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('renders escaped punctuation as literal text and reveals its exact escape when selected', () => {
    const source = '\\*literal\\* and `\\*code\\*`\n\nafter';
    const editor = mountLiveEditor(source);
    expect(editor.view.dom.textContent).toContain('*literal*');
    expect(editor.view.dom.textContent).toContain('\\*code\\*');
    expect(editor.parent.querySelector('.cm-live-emphasis')).toBeNull();
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(editor.view.dom.textContent).toContain('\\*literal');
    expect(editor.view.state.doc.toString()).toBe(source);
    editor.destroy();
  });

  it('keeps fenced-code chrome stable while selecting code text and reveals source from its label', () => {
    const source = '```ts\nconst first = 1;\nconst second = 2;\n```';
    const first = source.indexOf('const first');
    const secondEnd = source.indexOf(';', source.indexOf('const second')) + 1;
    const editor = mountLiveEditor(source, first);
    const label = editor.parent.querySelector<HTMLButtonElement>('.cm-live-code-label');
    expect(label).toBeTruthy();

    editor.view.dispatch({ selection: { anchor: first, head: secondEnd } });

    expect(editor.view.state.selection.main.from).toBe(first);
    expect(editor.view.state.selection.main.to).toBe(secondEnd);
    expect(editor.parent.querySelector('.cm-live-code-label')).toBe(label);
    expect(label?.isConnected).toBe(true);
    expect(editor.view.state.doc.toString()).toBe(source);

    fireEvent.click(label!);
    expect(editor.parent.querySelector('.cm-live-code-label')).toBeNull();
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(editor.view.state.doc.toString()).toBe(source);
    editor.destroy();
  });

  it('renders exact LocalView highlight and color pairs and reveals nested source when active', () => {
    const source = '<span data-localview-color="blue"><mark>bright **bold**</mark></span> after';
    const editor = mountLiveEditor(source, source.length);
    expect(editor.parent.querySelector('.cm-live-color-blue')).toBeTruthy();
    expect(editor.parent.querySelector('.cm-live-highlight')).toBeTruthy();
    expect(editor.view.dom.textContent).not.toContain('<mark>');
    expect(editor.view.dom.textContent).not.toContain('data-localview-color');

    const bright = source.indexOf('bright');
    editor.view.dispatch({ selection: { anchor: bright + 2 } });
    expect(editor.view.dom.textContent).toContain('<mark>bright bold</mark>');
    expect(editor.view.dom.textContent).toContain('<span data-localview-color="blue">');
    expect(editor.parent.querySelector('.cm-live-highlight')).toBeNull();
    expect(editor.parent.querySelector('.cm-live-color-blue')).toBeNull();
    expect(editor.view.state.doc.toString()).toBe(source);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('fails closed for LocalView tags in code, malformed pairs, and unknown colors', () => {
    const fixtures = [
      '`<mark>code</mark>`',
      '<mark>unclosed',
      '<mark><span data-localview-color="red">cross</mark></span>',
      '<span data-localview-color="pink">unknown</span>',
    ];
    fixtures.forEach((source) => {
      const editor = mountLiveEditor(source, source.length);
      expect(editor.parent.querySelector('.cm-live-highlight')).toBeNull();
      expect(editor.parent.querySelector('[class*="cm-live-color-"]')).toBeNull();
      expect(editor.view.state.doc.toString()).toBe(source);
      expect(editor.updates).toHaveLength(0);
      editor.destroy();
    });
  });

  it('reveals nested ancestor markers at endpoints and keeps sibling syntax rendered', () => {
    const source = '**bold *italic*** and ~~sibling~~';
    const editor = mountLiveEditor(source, source.indexOf('italic') + 2);
    expect(editor.view.dom.textContent).toContain('**bold *italic***');
    expect(editor.view.dom.textContent).not.toContain('~~sibling~~');

    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(editor.view.dom.textContent).toContain('**bold italic**');
    expect(editor.view.dom.textContent).not.toContain('*italic*');
    editor.view.dispatch({ selection: { anchor: '**bold *italic***'.length } });
    expect(editor.view.dom.textContent).toContain('**bold italic**');
    expect(editor.view.dom.textContent).not.toContain('*italic*');
    expect(editor.view.state.doc.toString()).toBe(source);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('fails closed for escaped syntax and oversized image or table nodes', async () => {
    const escaped = '\\*literal* and \\_text_ and \\[label](url)';
    const escapedEditor = mountLiveEditor(escaped);
    expect(escapedEditor.view.dom.textContent).toContain('*literal* and _text_ and [label](url)');
    expect(escapedEditor.parent.querySelector('.cm-live-emphasis, .cm-live-link')).toBeNull();
    expect(escapedEditor.view.state.doc.toString()).toBe(escaped);
    escapedEditor.destroy();

    const oversizedImage = `![alt](${'a'.repeat(MARKDOWN_LIVE_PREVIEW_LIMITS.imageOrLinkCharacters + 1)})`;
    const imageEditor = mountLiveEditor(oversizedImage);
    await flushLiveBlockRefresh();
    expect(imageEditor.parent.querySelector('.cm-live-image')).toBeNull();
    expect(imageEditor.view.state.doc.toString()).toBe(oversizedImage);
    imageEditor.destroy();

    const headers = Array.from({ length: 50 }, (_, index) => `H${index}`);
    const delimiter = headers.map(() => '---');
    const rows = Array.from({ length: 10 }, (_, row) => headers.map((_, column) => `${row}-${column}`));
    const largeTable = [headers, delimiter, ...rows]
      .map((cells) => `| ${cells.join(' | ')} |`).join('\n');
    const tableEditor = mountLiveEditor(largeTable);
    await flushLiveBlockRefresh();
    expect(tableEditor.parent.querySelector('.cm-live-table-wrap')).toBeNull();
    expect(tableEditor.view.state.doc.toString()).toBe(largeTable);
    tableEditor.destroy();
  });

  it('renders semantic bounded table cells and reveals the exact source without changing it', async () => {
    const table = '| Name | Value |\n| :--- | ---: |\n| A | left\\|right |\n| B | two |';
    const editor = mountLiveEditor(`${table}\n\nafter`);
    const widget = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLElement>('.cm-live-table-wrap');
      expect(value).toBeTruthy();
      return value!;
    });
    expect(widget?.querySelectorAll('th')).toHaveLength(2);
    expect(widget?.querySelectorAll('td')).toHaveLength(4);
    expect(widget?.textContent).toContain('left|right');
    expect(widget?.querySelector('th')?.dataset.alignment).toBe('left');

    fireEvent.click(widget!.querySelector('button')!);
    expect(editor.parent.querySelector('.cm-live-table-wrap')).toBeNull();
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(editor.view.state.doc.toString()).toBe(`${table}\n\nafter`);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('renders inline styles inside inactive table cells with safe HTML and preserves cell-edit source', async () => {
    const source = '| **Title** | Value |\n| --- | --- |\n| ~~done~~ | <mark>*bright*</mark> |\n| <script>alert(1)</script> | [bad](javascript:alert) |\n\nafter';
    const editor = mountLiveEditor(source);
    await flushLiveBlockRefresh();
    const table = editor.parent.querySelector('table')!;
    expect(table.querySelector('th strong')?.textContent).toBe('Title');
    expect(table.querySelector('td del')?.textContent).toBe('done');
    expect(table.querySelector('td mark em')?.textContent).toBe('bright');
    expect(table.querySelector('script')).toBeNull();
    expect(table.querySelector('a')?.getAttribute('href')).not.toMatch(/^javascript:/);
    fireEvent.click(table.querySelector('td')!);
    await flushLiveBlockRefresh();
    expect(editor.parent.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('~~done~~');
    expect(editor.view.state.doc.toString()).toBe(source);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('renders a table when the initial caret is inside it and reveals source only explicitly', async () => {
    const table = '| Name | Value |\n| --- | --- |\n| A | one |';
    const source = `${table}\n\nafter`;
    const editor = mountLiveEditor(source, 0);
    const widget = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLElement>('.cm-live-table-wrap');
      expect(value).toBeTruthy();
      return value!;
    });

    expect(editor.view.state.selection.main.head).toBe(0);
    fireEvent.click(widget.querySelector<HTMLButtonElement>('.cm-live-source-button')!);
    await waitFor(() => expect(editor.parent.querySelector('.cm-live-table-wrap')).toBeNull());
    expect(editor.view.state.selection.main.head).toBe(0);

    editor.view.dispatch({ selection: { anchor: source.length } });
    await waitFor(() => expect(editor.parent.querySelector('.cm-live-table-wrap')).toBeTruthy());
    editor.destroy();
  });

  it('edits one table cell in place and synchronizes every input to Markdown source', async () => {
    const table = '| 名称 | 内容 |\n| --- | --- |\n| A | 初始 |';
    const editor = mountLiveEditor(`${table}\n\nafter`);
    const cell = await waitFor(() => {
      const value = editor.parent.querySelectorAll<HTMLTableCellElement>('td')[1];
      expect(value).toBeTruthy();
      return value;
    });
    fireEvent.click(cell);
    const input = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    input.value = '新|值\n第二行';
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.input(input);

    expect(editor.view.state.doc.toString()).toContain('| A | 新\\|值 第二行 |');
    expect(editor.updates[editor.updates.length - 1]).toBe(editor.view.state.doc.toString());
    expect(editor.parent.querySelectorAll('.cm-live-table-input')).toHaveLength(1);
    editor.destroy();
  });

  it('keeps the active textarea during IME composition and supports native context menu', async () => {
    const table = '| A |\n| --- |\n| 初始 |';
    const editor = mountLiveEditor(`${table}\n\nafter`);
    const cell = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTableCellElement>('td');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.click(cell);
    const input = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.compositionStart(input);
    input.value = '中文';
    input.setSelectionRange(2, 2);
    fireEvent.input(input);
    expect(editor.parent.querySelector('.cm-live-table-input')).toBe(input);
    expect(input.isConnected).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(editor.parent.querySelector('.cm-live-table-input')).toBe(input);
    expect(input.isConnected).toBe(true);
    fireEvent.compositionEnd(input);
    await waitFor(() => expect(editor.view.state.doc.toString()).toContain('| 中文 |'));

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    input.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    editor.destroy();
  });

  it('clears a stale active cell after the table is removed and lets callers continue', async () => {
    const table = '| A |\n| --- |\n| value |';
    const editor = mountLiveEditor(`${table}\n\nafter`);
    const cell = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTableCellElement>('td');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.click(cell);
    await waitFor(() => expect(getActiveMarkdownTableCell(editor.view)).toBeTruthy());

    editor.view.dispatch({ changes: { from: 0, to: table.length, insert: 'plain text' } });

    expect(getActiveMarkdownTableCell(editor.view)).toBeNull();
    expect(flushActiveMarkdownTableCell(editor.view)).toBe(true);
    editor.destroy();
  });

  it('patches a 500-cell table without replacing the active DOM or selection', async () => {
    const headers = Array.from({ length: 25 }, (_, index) => `H${index}`);
    const delimiter = headers.map(() => '---');
    const rows = Array.from({ length: 19 }, (_, row) => headers.map((_, column) => `${row}-${column}`));
    const table = [headers, delimiter, ...rows]
      .map((cells) => `| ${cells.join(' | ')} |`).join('\n');
    const editor = mountLiveEditor(`${table}\n\nafter`);
    const cell = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTableCellElement>('td');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.click(cell);
    const section = await waitFor(() => editor.parent.querySelector<HTMLElement>('.cm-live-table-wrap')!);
    const renderedTable = section.querySelector('table');
    const input = await waitFor(() => section.querySelector<HTMLTextAreaElement>('.cm-live-table-input')!);
    input.focus();
    input.value = 'continuous-input';
    input.setSelectionRange(7, 7);
    fireEvent.input(input);
    await flushLiveBlockRefresh();

    expect(editor.parent.querySelector('.cm-live-table-wrap')).toBe(section);
    expect(section.querySelector('table')).toBe(renderedTable);
    expect(section.querySelector('.cm-live-table-input')).toBe(input);
    expect(input.selectionStart).toBe(7);
    expect(input.selectionEnd).toBe(7);
    editor.destroy();
  });

  it('closes an active cell on blur and restores focus at Tab boundaries', async () => {
    const table = '| A | B |\n| --- | --- |\n| one | two |';
    const editor = mountLiveEditor(`${table}\n\nafter`);
    const last = await waitFor(() => {
      const cells = editor.parent.querySelectorAll<HTMLTableCellElement>('td');
      expect(cells).toHaveLength(2);
      return cells[1];
    });
    fireEvent.click(last);
    let input = await waitFor(() => editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input')!);
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(editor.parent.querySelector('.cm-live-table-input')).toBeNull());
    await flushLiveBlockRefresh();
    const restored = editor.parent.querySelectorAll<HTMLTableCellElement>('td')[1];
    expect(document.activeElement).toBe(restored);

    fireEvent.click(restored);
    input = await waitFor(() => editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input')!);
    fireEvent.blur(input, { relatedTarget: document.body });
    await Promise.resolve();
    await waitFor(() => expect(editor.parent.querySelector('.cm-live-table-input')).toBeNull());
    editor.destroy();
  });

  it('navigates cells with Tab and routes Command-Z/redo to CodeMirror history', async () => {
    const table = '| A | B |\n| --- | --- |\n| one | two |';
    const source = `${table}\n\nafter`;
    const editor = mountLiveEditor(source);
    const first = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTableCellElement>('th');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.click(first);
    let input = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    input.value = 'Changed';
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.input(input);
    input = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.keyDown(input, { key: 'z', metaKey: true });
    await waitFor(() => expect(editor.view.state.doc.toString()).toBe(source));
    input = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.keyDown(input, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(editor.view.state.doc.toString()).toContain('| Changed | B |'));

    input = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.keyDown(input, { key: 'Tab' });
    const next = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    expect(next.getAttribute('aria-label')).toContain('第 2 列');
    fireEvent.keyDown(next, { key: 'Escape' });
    await waitFor(() => expect(editor.parent.querySelector('.cm-live-table-input')).toBeNull());
    editor.destroy();
  });

  it('defers measure writes, coalesces latest-wins refreshes, and short-circuits equal signatures', async () => {
    const first = '| First |\n| --- |\n| one |';
    const second = '| Second |\n| --- |\n| two |';
    const source = `${first}\n\n${second}\n\nafter`;
    const capture = captureLiveBlockMeasure();
    const editor = mountLiveEditor(source, first.length + 1);
    const scheduled = capture.requests.find(({ request }) => request.key !== undefined);
    expect(scheduled).toBeTruthy();
    const measured = scheduled!.request.read(editor.view) as {
      ranges: Array<{ from: number; to: number }>;
      signature: string;
    };
    const secondFrom = source.indexOf(second);
    const signatureFor = (from: number, to: number) => (
      `${source.length}|${first.length + 1}:${first.length + 1}|0|${from}:${to}`
    );

    for (let index = 0; index < 19; index += 1) {
      scheduled!.request.write({
        ...measured,
        ranges: [{ from: 0, to: first.length }],
        signature: signatureFor(0, first.length),
      }, editor.view);
    }
    scheduled!.request.write({
      ...measured,
      ranges: [{ from: secondFrom, to: secondFrom + second.length }],
      signature: signatureFor(secondFrom, secondFrom + second.length),
    }, editor.view);
    expect(editor.transactions).toHaveLength(0);

    await Promise.resolve();
    expect(editor.transactions).toEqual([{ docChanged: false }]);
    expect(editor.parent.querySelector('.cm-live-table-wrap')?.textContent).toContain('Second');
    expect(editor.parent.querySelector('.cm-live-table-wrap')?.textContent).not.toContain('First');

    scheduled!.request.write({
      ...measured,
      ranges: [{ from: secondFrom, to: secondFrom + second.length }],
      signature: signatureFor(secondFrom, secondFrom + second.length),
    }, editor.view);
    await Promise.resolve();
    expect(editor.transactions).toHaveLength(1);
    editor.destroy();
    capture.spy.mockRestore();
  });

  it('drops pending block refreshes after document, selection, or lifecycle changes', async () => {
    const source = '| Name |\n| --- |\n| value |\n\nafter';

    for (const invalidate of ['document', 'selection', 'destroy'] as const) {
      const capture = captureLiveBlockMeasure();
      const editor = mountLiveEditor(source, source.length);
      const scheduled = capture.requests.find(({ request }) => request.key !== undefined);
      expect(scheduled).toBeTruthy();
      const measured = scheduled!.request.read(editor.view);
      scheduled!.request.write(measured, editor.view);

      if (invalidate === 'document') {
        editor.view.dispatch({ changes: { from: source.length, insert: '!' } });
      } else if (invalidate === 'selection') {
        editor.view.dispatch({ selection: { anchor: 0 } });
      } else {
        editor.destroy();
      }
      const transactionCount = editor.transactions.length;
      await Promise.resolve();
      expect(editor.transactions).toHaveLength(transactionCount);
      if (invalidate !== 'destroy') editor.destroy();
      capture.spy.mockRestore();
    }
  });

  it('uses a stable image widget, remeasures once after load/error, and cleans up safely', async () => {
    const source = '![diagram](data:image/svg+xml,ok)\n\nafter';
    const editor = mountLiveEditor(source);
    const figure = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLElement>('.cm-live-image');
      expect(value).toBeTruthy();
      return value!;
    });
    const image = figure?.querySelector('img');
    expect(figure).toBeTruthy();
    expect(image?.getAttribute('src')).toBe('data:image/svg+xml,ok');
    const requestMeasure = vi.spyOn(editor.view, 'requestMeasure');
    fireEvent.load(image!);
    fireEvent.error(image!);
    const ownMeasureCalls = () => requestMeasure.mock.calls
      .filter(([request]) => request?.key === figure);
    expect(ownMeasureCalls()).toHaveLength(1);

    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(editor.parent.querySelector('.cm-live-image')).toBeNull();
    fireEvent.load(image!);
    expect(ownMeasureCalls()).toHaveLength(1);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('toggles a task checkbox through one document transaction and tracks runtime locks', async () => {
    const source = '- [ ] task\n\nafter';
    const editor = mountLiveEditor(source);
    const checkbox = editor.parent.querySelector<HTMLInputElement>('.cm-live-task-checkbox');
    expect(checkbox?.disabled).toBe(false);
    fireEvent.click(checkbox!);
    expect(editor.view.state.doc.toString()).toBe('- [x] task\n\nafter');
    expect(editor.updates).toEqual(['- [x] task\n\nafter']);
    editor.destroy();

    const locked = mountLiveEditor(source, source.length, { editable: false });
    const lockedCheckbox = locked.parent.querySelector<HTMLInputElement>('.cm-live-task-checkbox');
    expect(lockedCheckbox?.disabled).toBe(true);
    fireEvent.click(lockedCheckbox!);
    expect(locked.view.state.doc.toString()).toBe(source);
    expect(locked.updates).toHaveLength(0);
    locked.destroy();

    const runtimeLocked = mountLiveEditor(source);
    const runtimeCheckbox = runtimeLocked.parent.querySelector<HTMLInputElement>(
      '.cm-live-task-checkbox',
    );
    runtimeLocked.setEditable(false);
    expect(runtimeCheckbox?.disabled).toBe(true);
    if (runtimeCheckbox) runtimeCheckbox.disabled = false;
    fireEvent.click(runtimeCheckbox!);
    expect(runtimeLocked.view.state.doc.toString()).toBe(source);
    expect(runtimeLocked.updates).toHaveLength(0);
    runtimeLocked.setEditable(true);
    expect(runtimeCheckbox?.disabled).toBe(false);
    runtimeLocked.destroy();

    for (const blockSource of [
      '![alt](fixture.svg)\n\nafter',
      '| A | B |\n| --- | --- |\n| value | second |\n\nafter',
    ]) {
      const block = mountLiveEditor(blockSource);
      await flushLiveBlockRefresh();
      const sourceButton = await waitFor(() => {
        const value = block.parent.querySelector<HTMLButtonElement>('.cm-live-source-button');
        expect(value).toBeTruthy();
        return value!;
      });
      const widget = sourceButton.parentElement;
      const selectionBeforeLock = block.view.state.selection;
      block.setEditable(false);
      expect(sourceButton.disabled).toBe(true);
      fireEvent.click(widget!);
      expect(block.view.state.selection.eq(selectionBeforeLock)).toBe(true);
      expect(widget?.isConnected).toBe(true);
      expect(block.view.state.doc.toString()).toBe(blockSource);
      expect(block.updates).toHaveLength(0);
      block.setEditable(true);
      expect(sourceButton.disabled).toBe(false);
      block.destroy();
    }

    const thematic = mountLiveEditor('---\n\nafter');
    const thematicButton = thematic.parent.querySelector<HTMLButtonElement>(
      '.cm-live-thematic-break',
    );
    expect(thematicButton).toBeTruthy();
    const thematicSelection = thematic.view.state.selection;
    thematic.setEditable(false);
    expect(thematicButton?.disabled).toBe(true);
    fireEvent.click(thematicButton!);
    expect(thematic.view.state.selection.eq(thematicSelection)).toBe(true);
    expect(thematicButton?.isConnected).toBe(true);
    thematic.setEditable(true);
    expect(thematicButton?.disabled).toBe(false);
    thematic.destroy();
  });

  it('keeps source byte-for-byte stable across cursor, selection, reveal, and composition interactions', async () => {
    const source = '![alt](missing.png)\n\n**bold**\n\n---';
    const editor = mountLiveEditor(source);
    const sourceButton = await waitFor(() => {
      const value = editor.parent.querySelector<HTMLButtonElement>('.cm-live-image button');
      expect(value).toBeTruthy();
      return value!;
    });
    const before = editor.view.state.doc.toString();
    fireEvent.click(sourceButton);
    const boldFrom = source.indexOf('bold');
    editor.view.dispatch({ selection: { anchor: boldFrom } });
    editor.view.dispatch({ selection: { anchor: boldFrom, head: boldFrom + 4 } });
    fireEvent(editor.view.contentDOM, new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
    fireEvent(editor.view.contentDOM, new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    editor.view.dispatch({ selection: { anchor: source.length } });
    expect(editor.view.state.doc.toString()).toBe(before);
    expect(editor.updates).toHaveLength(0);
    editor.destroy();
  });

  it('keeps markers visible through composition and rebuilds only after the final input transaction', async () => {
    const source = '**bold** after';
    const editor = mountLiveEditor(source);
    expect(editor.view.dom.textContent).not.toContain('**bold**');

    fireEvent(editor.view.contentDOM, new CompositionEvent('compositionstart', {
      bubbles: true,
      data: '中',
    }));
    expect(editor.view.dom.textContent).toContain('**bold**');
    editor.view.dispatch({
      changes: { from: source.length, insert: '中' },
      selection: { anchor: source.length + 1 },
      userEvent: 'input.type.compose',
    });
    fireEvent(editor.view.contentDOM, new CompositionEvent('compositionend', {
      bubbles: true,
      data: '中',
    }));
    expect(editor.view.dom.textContent).toContain('**bold**');
    await Promise.resolve();

    expect(editor.view.state.doc.toString()).toBe(`${source}中`);
    expect(editor.view.dom.textContent).not.toContain('**bold**');
    expect(editor.updates).toEqual([`${source}中`]);
    editor.destroy();
  });

  it('does not stringify a 500 KiB document during decoration builds', () => {
    const source = `paragraph ${'word '.repeat(100 * 1024)}`;
    const state = EditorState.create({
      doc: source,
      selection: { anchor: 0 },
      extensions: [
        MARKDOWN_GFM_EXTENSION,
        createMarkdownLivePreviewExtension({ resolveImageSource: (value) => value }),
      ],
    });
    const stringify = vi.spyOn(state.doc, 'toString');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state, parent });
    view.dispatch({ selection: { anchor: 10 } });
    expect(stringify).not.toHaveBeenCalled();
    view.destroy();
    parent.remove();
  });
});
