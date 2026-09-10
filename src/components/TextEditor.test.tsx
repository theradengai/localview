import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { createRef } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '../style.css';
import { getActiveMarkdownTableCell } from '../lib/markdownLivePreview';
import TextEditor, { type TextEditorHandle } from './TextEditor';
import type { PasteImagesHandler } from '../lib/imagePaste';

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
  taskToggleEnabled,
  markdownPresentation = 'source' as const,
  onChange = vi.fn(),
  onPasteImages,
  onPasteError,
  ref,
}: {
  documentKey?: string;
  kind?: 'md' | 'html' | 'text';
  value?: string;
  editable?: boolean;
  taskToggleEnabled?: boolean;
  markdownPresentation?: 'live' | 'source';
  onChange?: (value: string) => void;
  onPasteImages?: import('../lib/imagePaste').PasteImagesHandler;
  onPasteError?: (message: string) => void;
  ref?: React.Ref<TextEditorHandle>;
} = {}) {
  return render(<TextEditor
    ref={ref}
    documentKey={documentKey}
    kind={kind}
    value={value}
    editable={editable}
    taskToggleEnabled={taskToggleEnabled}
    markdownPresentation={markdownPresentation}
    resolveMarkdownImageSource={(source) => source}
    hint={null}
    onChange={onChange}
    onPasteImages={onPasteImages}
    onPasteError={onPasteError}
  />);
}

describe('TextEditor Markdown interactions', () => {
  it.each(['\r\n', '\r', '\r\n\n'])('preserves original %j line endings when toggling and undoing a task', (ending) => {
    const ref = createRef<TextEditorHandle>();
    const source = `# 😀${ending}- [ ] parent${ending}      - [X] child\ntail\r\n`;
    const onChange = vi.fn();
    const editor = renderEditor({ ref, value: source, editable: false, taskToggleEnabled: true, onChange });
    act(() => expect(ref.current!.toggleMarkdownTask('doc', {
      source, statusOffset: source.indexOf('[X]') + 1, checked: false,
    })).toBe(true));
    const changed = source.replace('[X]', '[ ]');
    expect(onChange).toHaveBeenLastCalledWith(changed);
    editor.rerender(<TextEditor ref={ref} documentKey="doc" kind="md" value={changed} editable={false}
      taskToggleEnabled markdownPresentation="source" resolveMarkdownImageSource={value => value} hint={null} onChange={onChange} />);
    act(() => expect(ref.current!.taskHistory('doc', 'undo')).toBe(true));
    expect(onChange).toHaveBeenLastCalledWith(source);
    act(() => expect(ref.current!.taskHistory('doc', 'redo')).toBe(true));
    expect(onChange).toHaveBeenLastCalledWith(changed);
  });
  it('toggles preview tasks while source input stays locked, with separate undo steps and exact source preservation', async () => {
    const ref = createRef<TextEditorHandle>();
    const source = '- [ ] first\n      - [X] second\n\nend';
    const onChange = vi.fn();
    const editor = renderEditor({ ref, value: source, editable: false, taskToggleEnabled: true, onChange });
    const { view } = editorView(editor.container);
    act(() => expect(ref.current!.toggleMarkdownTask('doc', { source, statusOffset: source.indexOf('[ ]') + 1, checked: true })).toBe(true));
    const first = source.replace('[ ]', '[x]');
    expect(view.state.doc.toString()).toBe(first);
    act(() => expect(ref.current!.toggleMarkdownTask('doc', { source: first, statusOffset: first.indexOf('[X]') + 1, checked: false })).toBe(true));
    expect(view.state.doc.toString()).toBe(first.replace('[X]', '[ ]'));
    act(() => expect(ref.current!.taskHistory('doc', 'undo')).toBe(true));
    expect(view.state.doc.toString()).toBe(first);
    act(() => expect(ref.current!.taskHistory('doc', 'undo')).toBe(true));
    expect(view.state.doc.toString()).toBe(source);
    act(() => expect(ref.current!.taskHistory('doc', 'redo')).toBe(true));
    expect(view.state.doc.toString()).toBe(first);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('rejects stale source, wrong document keys, invalid offsets and runtime locks for preview task commands', () => {
    const ref = createRef<TextEditorHandle>();
    const source = '- [ ] task';
    const editor = renderEditor({ ref, value: source, editable: false, taskToggleEnabled: true });
    const { view } = editorView(editor.container);
    const change = { source, statusOffset: 3, checked: true };
    expect(ref.current!.toggleMarkdownTask('other', change)).toBe(false);
    expect(ref.current!.toggleMarkdownTask('doc', { ...change, source: source + ' stale' })).toBe(false);
    expect(ref.current!.toggleMarkdownTask('doc', { ...change, statusOffset: 4 })).toBe(false);
    editor.rerender(<TextEditor ref={ref} documentKey="doc" kind="md" value={source} editable={false}
      taskToggleEnabled={false} markdownPresentation="source" resolveMarkdownImageSource={value => value} hint={null} onChange={vi.fn()} />);
    expect(ref.current!.toggleMarkdownTask('doc', change)).toBe(false);
    expect(ref.current!.taskHistory('doc', 'undo')).toBe(false);
    expect(view.state.doc.toString()).toBe(source);
  });

  function pasteImage(target: HTMLElement) {
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    fireEvent.paste(target, { clipboardData: {
      items: [{ kind: 'file', type: image.type, getAsFile: () => image }],
      files: [image], getData: () => 'clipboard fallback text',
    } });
    return image;
  }

  it.each(['live', 'source'] as const)('pastes screenshots in %s with one undoable replacement', async (markdownPresentation) => {
    const onChange = vi.fn();
    const onPasteImages = vi.fn<PasteImagesHandler>(async (_files, insert) => { insert(['assets/one.png', 'assets/two.png']); });
    const editor = renderEditor({ value: 'before selected after', markdownPresentation, onChange, onPasteImages });
    const { content, view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: 7, head: 15 } }));
    const image = pasteImage(content);
    await waitFor(() => expect(view.state.doc.toString()).toBe('before ![截图](assets/one.png)\n![截图](assets/two.png) after'));
    expect(onPasteImages.mock.calls[0][0]).toEqual([image]);
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(content, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.state.doc.toString()).toBe('before selected after'));
  });

  it('does not insert a late attachment result into changed content', async () => {
    let complete!: (sources: string[]) => boolean;
    const onPasteImages = vi.fn<PasteImagesHandler>(async (_files, insert) => { complete = insert; });
    const editor = renderEditor({ onPasteImages });
    const { content, view } = editorView(editor.container);
    pasteImage(content);
    act(() => view.dispatch({ changes: { from: 0, insert: 'new ' } }));
    act(() => expect(complete(['assets/late.png'])).toBe(false));
    expect(view.state.doc.toString()).toBe('new hello');
  });

  it('does not insert a late attachment result after the editor unmounts', () => {
    let complete!: (sources: string[]) => boolean;
    const editor = renderEditor({ onPasteImages: async (_files, insert) => { complete = insert; } });
    pasteImage(editorView(editor.container).content);
    editor.unmount();
    expect(complete(['assets/late.png'])).toBe(false);
  });

  it('retains source and selection when attachment writing fails', async () => {
    const onPasteError = vi.fn();
    const editor = renderEditor({ onPasteError, onPasteImages: async () => { throw new Error('磁盘已满'); } });
    const { content, view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: 1, head: 4 } }));
    pasteImage(content);
    await waitFor(() => expect(onPasteError).toHaveBeenCalledWith('磁盘已满'));
    expect(view.state.doc.toString()).toBe('hello');
    expect(view.state.selection.main.from).toBe(1);
    expect(view.state.selection.main.to).toBe(4);
  });

  it('preserves ordinary text paste and does not save images from read-only editors', async () => {
    const onPasteImages = vi.fn();
    const editor = renderEditor({ onPasteImages });
    const { content, view } = editorView(editor.container);
    fireEvent.paste(content, { clipboardData: { items: [], files: [], getData: () => 'text ' } });
    expect(view.state.doc.toString()).toBe('text hello');
    expect(onPasteImages).not.toHaveBeenCalled();
    editor.unmount();
    const locked = renderEditor({ editable: false, onPasteImages });
    pasteImage(editorView(locked.container).content);
    expect(onPasteImages).not.toHaveBeenCalled();
  });

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

  it.each([
    ['粗体', '**hello** world'],
    ['斜体', '*hello* world'],
    ['删除线', '~~hello~~ world'],
    ['行内代码', '`hello` world'],
    ['标题 1', '# hello world'],
    ['标题 2', '## hello world'],
    ['标题 3', '### hello world'],
    ['引用', '> hello world'],
    ['无序列表', '- hello world'],
    ['有序列表', '1. hello world'],
    ['任务列表', '- [ ] hello world'],
  ])('applies %s from the toolbar without stealing selection, as one undoable change', async (label, expected) => {
    const onChange = vi.fn();
    const editor = renderEditor({ value: 'hello world', markdownPresentation: 'live', onChange });
    const { content, view } = editorView(editor.container);
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 5 } });
    });
    await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    expect(document.activeElement).toBe(content);
    fireEvent.pointerDown(screen.getByRole('button', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(view.state.doc.toString()).toBe(expected);
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

    fireEvent.pointerDown(content, { button: 2 });
    expect(contextMenu(content).defaultPrevented).toBe(false);
    expect(screen.getByRole('toolbar', { name: 'Markdown 快捷样式' })).toBeTruthy();
    fireEvent.pointerDown(content, { button: 2, shiftKey: true });
    expect(contextMenu(content, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(screen.queryByRole('toolbar', { name: 'Markdown 快捷样式' })).toBeNull();
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

  it('opens the Markdown toolbar on an empty-selection right-click and keeps Shift-right-click native', async () => {
    const onChange = vi.fn();
    const editor = renderEditor({ value: 'hello', markdownPresentation: 'live', onChange });
    const { content, view } = editorView(editor.container);
    expect(view.state.selection.main.empty).toBe(true);

    fireEvent.pointerDown(content, { button: 2, clientX: 120, clientY: 80 });
    const localEvent = contextMenu(content, { clientX: 120, clientY: 80 });
    expect(localEvent.defaultPrevented).toBe(true);
    const toolbar = await screen.findByRole('toolbar', { name: 'Markdown 快捷样式' });
    expect(toolbar).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '粗体' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '高亮' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '字体颜色' }).disabled).toBe(true);
    fireEvent.pointerDown(screen.getByRole('button', { name: '粗体' }));
    fireEvent.click(screen.getByRole('button', { name: '粗体' }));
    expect(view.state.doc.toString()).toBe('he****llo');
    expect(onChange).toHaveBeenCalledTimes(1);

    const nativeEditor = renderEditor({ value: 'native', markdownPresentation: 'live' });
    const native = editorView(nativeEditor.container);
    const nativeEvent = contextMenu(native.content, {
      clientX: 120,
      clientY: 80,
      shiftKey: true,
    });
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole('toolbar', { name: 'Markdown 快捷样式' })).toBeNull();
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

  it('uses the active Live Preview cell for table tools and exposes a synchronous flush', async () => {
    const table = '| A | B |\n| --- | --- |\n| x | y |';
    const source = `${table}\n\nafter`;
    const ref = createRef<TextEditorHandle>();
    const onChange = vi.fn();
    const editor = renderEditor({
      value: source,
      ref,
      onChange,
      markdownPresentation: 'live',
    });
    const { view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: source.length } }));
    const cell = await waitFor(() => {
      const value = editor.container.querySelectorAll<HTMLTableCellElement>('td')[0];
      expect(value).toBeTruthy();
      return value;
    });
    fireEvent.click(cell);
    let input = await waitFor(() => {
      const value = editor.container.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    input.value = 'changed|value';
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.input(input);
    expect(ref.current?.flushMarkdownCellEdit()).toBe(true);
    expect(view.state.doc.toString()).toContain('| changed\\|value | y |');

    act(() => expect(ref.current?.openMarkdownTableTools({ x: 20, y: 20 })).toBe(true));
    const addRowBelow = await screen.findByRole('menuitem', { name: '在下方添加行' });
    await waitFor(() => expect(getActiveMarkdownTableCell(view)).toBeNull());
    fireEvent.click(addRowBelow);
    expect(view.state.doc.toString()).toContain('| changed\\|value | y |\n|  |  |');
    expect(getActiveMarkdownTableCell(view)?.active.row).toBe(1);
    input = await waitFor(() => {
      const value = editor.container.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    expect(input.getAttribute('aria-label')).toContain('第 2 行第 1 列');
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(editor.container.querySelector<HTMLButtonElement>('.cm-live-source-button')!);
    await waitFor(() => expect(editor.container.querySelector('.cm-live-table-wrap')).toBeNull());
    expect(view.state.doc.toString()).toContain('| changed\\|value | y |');
  });

  it('flushes the final IME textarea value before an explicit save reads editor content', async () => {
    const table = '| A |\n| --- |\n| 初始 |';
    const ref = createRef<TextEditorHandle>();
    const editor = renderEditor({
      value: `${table}\n\nafter`,
      ref,
      markdownPresentation: 'live',
    });
    const { view } = editorView(editor.container);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    const cell = await waitFor(() => {
      const value = editor.container.querySelector<HTMLTableCellElement>('td');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.click(cell);
    const input = await waitFor(() => {
      const value = editor.container.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      expect(value).toBeTruthy();
      return value!;
    });
    fireEvent.compositionStart(input);
    input.value = '中文尾字';
    input.setSelectionRange(input.value.length, input.value.length);

    expect(ref.current?.flushMarkdownCellEdit()).toBe(true);
    expect(view.state.doc.toString()).toContain('| 中文尾字 |');
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
