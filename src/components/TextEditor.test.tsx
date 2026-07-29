import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { createRef } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '../style.css';
import TextEditor, { type TextEditorHandle } from './TextEditor';

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

function contextMenu(target: HTMLElement, options: MouseEventInit = {}) {
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

function renderEditor({
  documentKey = 'doc',
  kind = 'md' as const,
  value = 'hello',
  editable = true,
  markdownPresentation = 'source' as const,
  onChange = vi.fn(),
  ref,
}: {
  documentKey?: string;
  kind?: 'md' | 'html' | 'text';
  value?: string;
  editable?: boolean;
  markdownPresentation?: 'live' | 'source';
  onChange?: (value: string) => void;
  ref?: React.Ref<TextEditorHandle>;
} = {}) {
  return render(<TextEditor
    ref={ref}
    documentKey={documentKey}
    kind={kind}
    value={value}
    editable={editable}
    markdownPresentation={markdownPresentation}
    resolveMarkdownImageSource={(source) => source}
    hint={null}
    onChange={onChange}
  />);
}

describe('TextEditor Markdown interactions', () => {
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

  it('enables line wrapping only for Markdown source', () => {
    const markdown = renderEditor({ value: 'long Markdown line' });
    expect(editorView(markdown.container).content.classList.contains('cm-lineWrapping')).toBe(true);
    markdown.unmount();
    const html = renderEditor({ kind: 'html', value: '<p>long source</p>' });
    expect(editorView(html.container).content.classList.contains('cm-lineWrapping')).toBe(false);
  });

  it('mounts Live Preview and removes heading underlines without removing link underlines', () => {
    const source = '# Plain heading\n\n## [Linked heading](docs/a.md)';
    const editor = renderEditor({ value: source, markdownPresentation: 'live' });
    const { view } = editorView(editor.container);
    expect(view.dom.dataset.markdownLivePreview).toBe('true');
    const heading = editor.container.querySelector<HTMLElement>('.cm-live-heading-1');
    const link = editor.container.querySelector<HTMLElement>('.cm-live-link');
    expect(heading).toBeTruthy();
    expect(link).toBeTruthy();
    expect(getComputedStyle(heading!).textDecoration).not.toContain('underline');
    expect(link?.classList.contains('cm-live-link')).toBe(true);
  });

  it('shows the selection toolbar without stealing focus and applies one undoable change', async () => {
    const onChange = vi.fn();
    const editor = renderEditor({ value: 'hello world', markdownPresentation: 'live', onChange });
    const { content, view } = editorView(editor.container);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 5 } });
    });
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    expect(document.activeElement).toBe(content);
    fireEvent.pointerDown(screen.getByRole('button', { name: '粗体' }));
    fireEvent.click(screen.getByRole('button', { name: '粗体' }));
    expect(view.state.doc.toString()).toBe('**hello** world');
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.state.doc.toString()).toBe('hello world'));
  });

  it('applies highlight and fixed colors from the automatic toolbar', async () => {
    const onChange = vi.fn();
    const editor = renderEditor({ value: 'hello', markdownPresentation: 'live', onChange });
    const { view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    fireEvent.pointerDown(screen.getByRole('button', { name: '高亮' }));
    fireEvent.click(screen.getByRole('button', { name: '高亮' }));
    expect(view.state.doc.toString()).toBe('<mark>hello</mark>');

    act(() => view.dispatch({ selection: { anchor: 6, head: 11 } }));
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    fireEvent.pointerDown(screen.getByRole('button', { name: '字体颜色' }));
    fireEvent.click(screen.getByRole('button', { name: '字体颜色' }));
    const colorDialog = await screen.findByRole('dialog', { name: '选择字体颜色' });
    fireEvent.pointerDown(screen.getByRole('button', { name: '蓝色字体' }));
    fireEvent.click(screen.getByRole('button', { name: '蓝色字体' }));
    expect(colorDialog.isConnected).toBe(false);
    expect(view.state.doc.toString()).toBe(
      '<mark><span data-localview-color="blue">hello</span></mark>',
    );
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps ordinary, Shift, and keyboard context-menu paths native and side-effect free', async () => {
    const onChange = vi.fn();
    const editor = renderEditor({ value: 'hello', onChange });
    const { content, view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    const before = view.state.selection;

    expect(contextMenu(content).defaultPrevented).toBe(false);
    expect(contextMenu(content, { shiftKey: true }).defaultPrevented).toBe(false);
    for (const init of [
      { key: 'ContextMenu' },
      { key: 'F10', shiftKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      fireEvent(content, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(view.state.selection.eq(before)).toBe(true);
    expect(view.state.doc.toString()).toBe('hello');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu', { name: 'Markdown 样式' })).toBeNull();
  });

  it('does not reopen the toolbar after native right-click selection changes', async () => {
    const editor = renderEditor({ value: 'hello world' });
    const { content, view } = editorView(editor.container);

    fireEvent.pointerDown(content, { button: 2 });
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    expect(contextMenu(content).defaultPrevented).toBe(false);
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(screen.queryByRole('toolbar', { name: 'Markdown 快捷样式' })).toBeNull();

    fireEvent.pointerDown(content, { button: 0 });
    act(() => view.dispatch({ selection: { anchor: 6, head: 11 } }));
    fireEvent.pointerUp(content, { button: 0 });
    expect(await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' })).toBeTruthy();
  });

  it('focuses only an already visible selection toolbar with Alt+F10', async () => {
    const editor = renderEditor({ value: 'hello' });
    const { content, view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    fireEvent.keyDown(content, { key: 'F10', altKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '标题 1' }));
  });

  it('hides the toolbar during IME and finishes pointer gestures outside the editor', async () => {
    const editor = renderEditor({ value: 'hello', markdownPresentation: 'live' });
    const { content, view } = editorView(editor.container);
    fireEvent.pointerDown(content, { button: 0 });
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    expect(screen.queryByRole('toolbar', { name: 'Markdown 快捷样式' })).toBeNull();
    fireEvent.pointerUp(document.body, { button: 0 });
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    fireEvent(content, new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
    await waitFor(() => expect(screen.queryByRole('toolbar', {
      name: 'Markdown 快捷样式',
    })).toBeNull());
  });

  it('opens table tools imperatively without moving the selection', async () => {
    const ref = createRef<TextEditorHandle>();
    const editor = renderEditor({ value: '', ref });
    const { view } = editorView(editor.container);
    const before = view.state.selection;
    act(() => expect(ref.current?.openMarkdownTableTools({ x: 20, y: 20 })).toBe(true));
    expect(await screen.findByRole('menu', { name: 'Markdown 表格' })).toBeTruthy();
    expect(view.state.selection.eq(before)).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: '插入表格…' }));
    fireEvent.click(screen.getByRole('gridcell', { name: '3 列 × 2 行' }));
    expect(view.state.doc.toString()).toContain('| 列 1 | 列 2 | 列 3 |');
  });

  it('exposes strict top-level table actions and closes stale snapshots', async () => {
    const table = '| A | B |\n| --- | --- |\n| x | y |';
    const ref = createRef<TextEditorHandle>();
    const onChange = vi.fn();
    const editor = renderEditor({ value: table, ref, onChange });
    const { view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: table.indexOf('x') } }));
    act(() => ref.current?.openMarkdownTableTools({ x: 20, y: 20 }));
    expect(await screen.findByRole('menuitem', { name: '在下方添加行' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '插入表格…' })).toBeNull();

    act(() => view.dispatch({ selection: { anchor: table.indexOf('y') } }));
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Markdown 表格' })).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fails closed for locked, non-Markdown, and unmounted table handles', () => {
    for (const options of [
      { kind: 'html' as const, editable: true },
      { kind: 'md' as const, editable: false },
    ]) {
      const ref = createRef<TextEditorHandle>();
      const editor = renderEditor({ ...options, ref });
      expect(ref.current?.openMarkdownTableTools({ x: 20, y: 20 })).toBe(false);
      editor.unmount();
      expect(ref.current).toBeNull();
    }
  });
});
