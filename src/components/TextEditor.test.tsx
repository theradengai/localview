import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import type { ComponentProps } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import TextEditorComponent from './TextEditor';

const resolveTestImage = (source: string) => source;

function TextEditor({
  markdownPresentation = 'source',
  resolveMarkdownImageSource = resolveTestImage,
  ...props
}: Omit<
  ComponentProps<typeof TextEditorComponent>,
  'markdownPresentation' | 'resolveMarkdownImageSource'
> & Partial<Pick<
  ComponentProps<typeof TextEditorComponent>,
  'markdownPresentation' | 'resolveMarkdownImageSource'
>>) {
  return <TextEditorComponent
    {...props}
    markdownPresentation={markdownPresentation}
    resolveMarkdownImageSource={resolveMarkdownImageSource}
  />;
}

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function rect(left = 0, top = 0, width = 640, height = 480): DOMRect {
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

function editorView(container: HTMLElement) {
  const content = container.querySelector<HTMLElement>('.cm-content');
  if (!content) throw new Error('CodeMirror content DOM not found');
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('CodeMirror view not found');
  return { content, view };
}

function contextMenu(
  target: HTMLElement,
  options: MouseEventInit = {},
) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 20,
    ...options,
  });
  fireEvent(target, event);
  return event;
}

describe('TextEditor Markdown context menu', () => {
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

  it('enables CodeMirror line wrapping only for Markdown source', () => {
    const markdown = render(<TextEditor
      documentKey="doc-wrapping-md"
      kind="md"
      value="A long Markdown paragraph that should wrap inside a narrow split pane."
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    expect(editorView(markdown.container).content.classList.contains('cm-lineWrapping')).toBe(true);
    markdown.unmount();

    const html = render(<TextEditor
      documentKey="doc-wrapping-html"
      kind="html"
      value="<p>A long source line remains unchanged.</p>"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    expect(editorView(html.container).content.classList.contains('cm-lineWrapping')).toBe(false);
  });

  it('mounts live decorations only for the Markdown live presentation', () => {
    const onChange = vi.fn();
    const live = render(<TextEditor
      documentKey="doc-live"
      kind="md"
      value="# Heading"
      editable
      markdownPresentation="live"
      hint={null}
      onChange={onChange}
    />);
    expect(editorView(live.container).view.dom.dataset.markdownLivePreview).toBe('true');
    expect(live.container.querySelector('.cm-live-heading-1')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    live.unmount();

    const source = render(<TextEditor
      documentKey="doc-source"
      kind="md"
      value="# Heading"
      editable
      markdownPresentation="source"
      hint={null}
      onChange={onChange}
    />);
    expect(editorView(source.container).view.dom.dataset.markdownLivePreview).toBeUndefined();
    expect(source.container.querySelector('.cm-live-heading-1')).toBeNull();
  });

  it('shows the Markdown toolbar after selection without stealing focus and applies one transaction', async () => {
    const onChange = vi.fn();
    const { container } = render(<TextEditor
      documentKey="doc-selection-toolbar"
      kind="md"
      value="hello world"
      editable
      markdownPresentation="live"
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 5 } });
    });

    const toolbar = await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    expect(document.activeElement).toBe(content);
    expect(view.state.selection.main).toMatchObject({ anchor: 0, head: 5 });
    fireEvent.pointerDown(screen.getByRole('button', { name: '粗体' }));
    fireEvent.click(screen.getByRole('button', { name: '粗体' }));

    await waitFor(() => expect(toolbar.isConnected).toBe(false));
    expect(view.state.doc.toString()).toBe('**hello** world');
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.state.doc.toString()).toBe('hello world'));
  });

  it('focuses the automatic toolbar with Alt+F10 and keeps Shift-right-click native', async () => {
    const { container } = render(<TextEditor
      documentKey="doc-toolbar-native"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 5 } });
    });
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });

    fireEvent.keyDown(content, { key: 'F10', altKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '标题 1' }));
    const shifted = contextMenu(content, { shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    await waitFor(() => expect(screen.queryByRole('toolbar', {
      name: 'Markdown 快捷样式',
    })).toBeNull());
    expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull();
  });

  it('waits for pointerup and hides the toolbar during IME composition', async () => {
    const onChange = vi.fn();
    const { container } = render(<TextEditor
      documentKey="doc-toolbar-pointer-ime"
      kind="md"
      value="hello"
      editable
      markdownPresentation="live"
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    fireEvent.pointerDown(content, { button: 0 });
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    expect(screen.queryByRole('toolbar', { name: 'Markdown 快捷样式' })).toBeNull();
    fireEvent.pointerUp(content, { button: 0 });
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });

    fireEvent(content, new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
    await waitFor(() => expect(screen.queryByRole('toolbar', {
      name: 'Markdown 快捷样式',
    })).toBeNull());
    expect(view.state.doc.toString()).toBe('hello');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('finishes pointer gestures released or cancelled outside the editor', async () => {
    const { container } = render(<TextEditor
      documentKey="doc-toolbar-outside-pointer"
      kind="md"
      value="hello"
      editable
      markdownPresentation="live"
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);

    fireEvent.pointerDown(content, { button: 0 });
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    fireEvent.pointerUp(document.body, { button: 0 });
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });

    fireEvent.pointerDown(content, { button: 0 });
    fireEvent.pointerCancel(window);
    act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
  });

  it('preserves a selected range and applies one undoable CodeMirror transaction', async () => {
    const onChange = vi.fn();
    const { container } = render(<TextEditor
      documentKey="doc-one"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);

    const event = contextMenu(content);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '粗体' }));

    expect(view.state.doc.toString()).toBe('**hello**');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe('**hello**');

    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.state.doc.toString()).toBe('hello'));
  });

  it('moves the caret when right-clicking outside the current selection', async () => {
    const { container } = render(<TextEditor
      documentKey="doc-two"
      kind="md"
      value="hello world"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    vi.spyOn(view, 'posAtCoords').mockReturnValue(8);

    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    expect(view.state.selection.main).toMatchObject({ anchor: 8, head: 8 });
  });

  it('treats selection.to as outside the half-open selected range', async () => {
    const { container } = render(<TextEditor
      documentKey="doc-selection-end"
      kind="md"
      value="hello world"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    vi.spyOn(view, 'posAtCoords').mockReturnValue(5);

    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    expect(view.state.selection.main).toMatchObject({ anchor: 5, head: 5 });
  });

  it('leaves Shift-right-click and non-Markdown editors native', () => {
    const markdown = render(<TextEditor
      documentKey="doc-three"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const markdownEditor = editorView(markdown.container);
    const shifted = contextMenu(markdownEditor.content, { shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull();
    markdown.unmount();

    const html = render(<TextEditor
      documentKey="doc-html"
      kind="html"
      value="<p>hello</p>"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const htmlEditor = editorView(html.container);
    const native = contextMenu(htmlEditor.content);
    expect(native.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull();
  });

  it('closes immediately when the controlled document changes', async () => {
    const { container, rerender } = render(<TextEditor
      documentKey="doc-four"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });

    rerender(<TextEditor
      documentKey="doc-four"
      kind="md"
      value="changed externally"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull());
  });

  it('invalidates a menu snapshot when selection changes', async () => {
    const onChange = vi.fn();
    const { container } = render(<TextEditor
      documentKey="doc-selection-stale"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    act(() => view.dispatch({ selection: { anchor: 4 } }));
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ['documentKey', { documentKey: 'doc-stale-next', kind: 'md' as const, editable: true }],
    ['kind', { documentKey: 'doc-stale-props', kind: 'html' as const, editable: true }],
    ['editable', { documentKey: 'doc-stale-props', kind: 'md' as const, editable: false }],
  ])('invalidates a menu snapshot when %s changes', async (_label, next) => {
    const onChange = vi.fn();
    const { container, rerender } = render(<TextEditor
      documentKey="doc-stale-props"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });

    rerender(<TextEditor
      documentKey={next.documentKey}
      kind={next.kind}
      value="hello"
      editable={next.editable}
      hint={null}
      onChange={onChange}
    />);
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on ancestor scroll and does not open while editing is locked', async () => {
    const { container, rerender } = render(<TextEditor
      documentKey="doc-five"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    fireEvent.scroll(container);
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull());

    rerender(<TextEditor
      documentKey="doc-five"
      kind="md"
      value="hello"
      editable={false}
      hint={null}
      onChange={vi.fn()}
    />);
    const locked = contextMenu(content);
    expect(locked.defaultPrevented).toBe(false);
  });

  it.each(['Escape', 'outside', 'resize'] as const)('closes on %s and restores editor focus', async (reason) => {
    const { container } = render(<TextEditor
      documentKey={`doc-close-${reason}`}
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });

    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (reason === 'outside') fireEvent.pointerDown(document.body);
    else fireEvent(window, new Event('resize'));

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(content));
  });

  it('removes every global menu listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { container, unmount } = render(<TextEditor
      documentKey="doc-listener-cleanup"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const { content, view } = editorView(container);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    const start = add.mock.calls.length;
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    const listeners = add.mock.calls.slice(start).filter(([type]) => (
      type === 'pointerdown' || type === 'scroll' || type === 'resize' || type === 'keydown'
    ));
    expect(listeners.map(([type]) => type)).toEqual(['pointerdown', 'scroll', 'resize', 'keydown']);

    unmount();
    for (const listener of listeners) expect(remove).toHaveBeenCalledWith(...listener);
  });

  it('does not let an old focus RAF steal focus after close, reopen, or file switch', async () => {
    const { container, rerender } = render(<TextEditor
      documentKey="doc-focus-old"
      kind="md"
      value="hello"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const old = editorView(container);
    vi.spyOn(old.view, 'posAtCoords').mockReturnValue(2);
    contextMenu(old.content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    const oldFocus = vi.spyOn(old.view, 'focus');
    fireEvent.keyDown(window, { key: 'Escape' });

    rerender(<TextEditor
      documentKey="doc-focus-new"
      kind="md"
      value="new file"
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const current = editorView(container);
    vi.spyOn(current.view, 'posAtCoords').mockReturnValue(2);
    contextMenu(current.content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(oldFocus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(old.content);
  });

  it('opens a 500 KiB menu without converting the full document and converts once on command', async () => {
    const source = `hello${'x'.repeat(500 * 1024)}`;
    const onChange = vi.fn();
    const { container } = render(<TextEditor
      documentKey="doc-large"
      kind="md"
      value={source}
      editable
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    const toString = vi.spyOn(view.state.doc, 'toString');

    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    expect(toString).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: '粗体' }));
    expect(toString).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('treats escaped marker conflicts as a focused no-op with no change or undo entry', async () => {
    const source = '\\*literal*';
    const onChange = vi.fn();
    const { container } = render(<TextEditor
      documentKey="doc-escaped-marker"
      kind="md"
      value={source}
      editable
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 2, head: 9 } }));
    vi.spyOn(view, 'posAtCoords').mockReturnValue(4);
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    fireEvent.click(screen.getByRole('menuitem', { name: '斜体' }));

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(content));
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main).toMatchObject({ anchor: 2, head: 9 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    expect(view.state.doc.toString()).toBe(source);
  });

  it('does not dispatch an identity formatting transaction', async () => {
    const source = 'plain';
    const onChange = vi.fn();
    const { container } = render(<TextEditor
      documentKey="doc-identity-no-op"
      kind="md"
      value={source}
      editable
      hint={null}
      onChange={onChange}
    />);
    const { content, view } = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 0, head: source.length } }));
    vi.spyOn(view, 'posAtCoords').mockReturnValue(2);
    contextMenu(content);
    await screen.findByRole('menu', { name: 'Markdown 样式' });
    fireEvent.click(screen.getByRole('menuitem', { name: '取消列表' }));

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull());
    expect(view.state.doc.toString()).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    expect(view.state.doc.toString()).toBe(source);
  });

  it('shows table actions only for strict top-level GFM tables', async () => {
    const topLevel = '| A | B |\n| --- | --- |\n| x | y |';
    const top = render(<TextEditor
      documentKey="doc-top-table"
      kind="md"
      value={topLevel}
      editable
      hint={null}
      onChange={vi.fn()}
    />);
    const topEditor = editorView(top.container);
    vi.spyOn(topEditor.view, 'posAtCoords').mockReturnValue(topLevel.indexOf('x'));
    contextMenu(topEditor.content);
    expect(await screen.findByRole('menuitem', { name: '在下方添加行' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    top.unmount();

    for (const [index, source] of [
      '```\n| A | B |\n| --- | --- |\n| x | y |\n```',
      '- item\n  | A | B |\n  | --- | --- |\n  | x | y |',
      '> | A | B |\n> | --- | --- |\n> | x | y |',
    ].entries()) {
      const nested = render(<TextEditor
        documentKey={`doc-nested-table-${index}`}
        kind="md"
        value={source}
        editable
        hint={null}
        onChange={vi.fn()}
      />);
      const nestedEditor = editorView(nested.container);
      vi.spyOn(nestedEditor.view, 'posAtCoords').mockReturnValue(source.indexOf('x'));
      contextMenu(nestedEditor.content);
      await screen.findByRole('menu', { name: 'Markdown 样式' });
      expect(screen.queryByRole('menuitem', { name: '在下方添加行' })).toBeNull();
      nested.unmount();
    }
  });
});
