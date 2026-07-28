import { fireEvent, waitFor } from '@testing-library/react';
import { Compartment } from '@codemirror/state';
import { EditorState, EditorView } from '@uiw/react-codemirror';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MARKDOWN_GFM_EXTENSION } from './markdownLanguage';
import {
  MARKDOWN_LIVE_PREVIEW_LIMITS,
  createMarkdownLivePreviewExtension,
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
    expect(escapedEditor.view.dom.textContent).toContain(escaped);
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
