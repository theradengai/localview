import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import FileTree, { LOCALVIEW_TREE_DRAG_TYPE, MOVE_HOVER_OPEN_DELAY_MS } from './components/FileTree';
import {
  LAST_ACTIVE_WORKSPACE_SESSION_KEY,
  readWorkspaceSession,
} from './lib/workspaceSession';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  desktop: false,
  closeHandler: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
  focusHandler: undefined as ((event: { payload: boolean }) => void) | undefined,
  openPathHandler: undefined as ((path: string) => void) | undefined,
  quitRequestHandler: undefined as ((event: { generation: number }) => void) | undefined,
  quitAbortHandler: undefined as ((event: { generation: number }) => void) | undefined,
  printRequestHandler: undefined as (() => void) | undefined,
  workspaceChangeHandler: undefined as ((batch: import('./lib/desktop').WorkspaceChangeBatch) => void) | undefined,
  workspaceFailureHandler: undefined as ((failure: import('./lib/desktop').WorkspaceWatchFailure) => void) | undefined,
  setWorkspaceRoot: vi.fn(),
  inspectPath: vi.fn(),
  findWorkspaceRoot: vi.fn(),
  listDirectory: vi.fn(),
  getWindowBootstrap: vi.fn(),
  createWorkspaceWindow: vi.fn(),
  respondAppQuit: vi.fn(),
  printCurrentWindow: vi.fn(),
  waitForPrintableAssets: vi.fn(),
  readTextFile: vi.fn(),
  readSpreadsheet: vi.fn(),
  createDirectory: vi.fn(),
  createMarkdownFile: vi.fn(),
  writeTextFile: vi.fn(),
  savePastedImages: vi.fn(),
  prepareHtmlPreview: vi.fn(),
  releaseHtmlPreview: vi.fn(),
  prepareTrash: vi.fn(),
  moveToTrash: vi.fn(),
  chooseFolder: vi.fn(),
  chooseMoveDestination: vi.fn(),
  prepareWorkspaceMove: vi.fn(),
  moveWorkspaceEntry: vi.fn(),
  reconcileWorkspaceMove: vi.fn(),
  prepareWorkspaceRename: vi.fn(),
  renameWorkspaceEntry: vi.fn(),
  reconcileWorkspaceRename: vi.fn(),
  closeWindow: vi.fn(),
  destroyWindow: vi.fn(),
  generateSystemThumbnail: vi.fn(),
  showEmbeddedQuickLook: vi.fn(),
  resizeEmbeddedQuickLook: vi.fn(),
  hideEmbeddedQuickLook: vi.fn(),
  revealPath: vi.fn(),
}));

vi.mock('@uiw/react-codemirror', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof import('@uiw/react-codemirror')>();
  const EditorView = new Proxy(actual.EditorView, {
    get(target, property, receiver) {
      if (property === 'domEventHandlers') {
        return (handlers: Record<string, (...args: any[]) => boolean>) => ({
          __domEventHandlers: handlers,
        });
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    ...actual,
    EditorView,
    default: React.forwardRef(({
      value,
      onChange,
      editable = true,
      extensions = [],
    }: {
      value: string;
      onChange?: (value: string) => void;
      editable?: boolean;
      extensions?: Array<{ __domEventHandlers?: Record<string, (...args: any[]) => boolean> }>;
    }, forwardedRef) => {
      const [document, setDocument] = React.useState(value);
      const handlers = extensions.find((extension) => extension?.__domEventHandlers)?.__domEventHandlers;
      const view = React.useMemo(() => {
        const doc = {
          length: document.length,
          toString: () => document,
          eq: (other: unknown) => other === doc,
          lineAt: (position: number) => {
            const safe = Math.max(0, Math.min(position, document.length));
            const from = document.lastIndexOf('\n', safe - 1) + 1;
            const nextBreak = document.indexOf('\n', safe);
            const to = nextBreak === -1 ? document.length : nextBreak;
            return { from, to, text: document.slice(from, to) };
          },
        };
        const selection = {
          ranges: [{}],
          main: {
            anchor: 0,
            head: Math.min(1, document.length),
            from: 0,
            to: Math.min(1, document.length),
            empty: document.length === 0,
          },
          eq: (other: unknown) => other === selection,
        };
        return {
          state: {
            doc,
            selection,
            sliceDoc: (from: number, to: number) => document.slice(from, to),
          },
          dispatch: vi.fn((transaction: { userEvent?: string; changes?: { from: number; to: number; insert: string } }) => {
            if (transaction.userEvent !== 'input.paste' || !transaction.changes) return;
            const { from, to, insert } = transaction.changes;
            const next = document.slice(0, from) + insert + document.slice(to);
            setDocument(next);
            onChange?.(next);
          }),
          focus: vi.fn(),
        };
      }, [document]);
      React.useImperativeHandle(forwardedRef, () => ({ view }), [view]);
      return <>
        <textarea
          aria-label="editor"
          value={document}
          disabled={!editable}
          onChange={(event) => {
            setDocument(event.target.value);
            onChange?.(event.target.value);
          }}
        />
        {handlers?.contextmenu ? <button
          type="button"
          data-testid="mock-markdown-context"
          style={{ display: 'none' }}
          onClick={() => {
            handlers.contextmenu({
              shiftKey: false,
              clientX: 20,
              clientY: 20,
              preventDefault: vi.fn(),
            }, view);
          }}
        /> : null}
      </>;
    }),
  };
});

vi.mock('./lib/markdownLanguage', () => ({
  MARKDOWN_GFM_EXTENSION: {},
  findTopLevelGfmTableRange: () => null,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: mocks.closeWindow,
    destroy: mocks.destroyWindow,
    isFocused: vi.fn(async () => true),
    onFocusChanged: vi.fn(async (handler: typeof mocks.focusHandler) => {
      mocks.focusHandler = handler;
      return () => undefined;
    }),
    onCloseRequested: vi.fn(async (handler: typeof mocks.closeHandler) => {
      mocks.closeHandler = handler;
      return () => undefined;
    }),
  }),
}));

vi.mock('./lib/desktop', async () => {
  const actual = await vi.importActual<typeof import('./lib/desktop')>('./lib/desktop');
  return {
    ...actual,
    isTauriRuntime: () => mocks.desktop,
    chooseFolder: mocks.chooseFolder,
    chooseMoveDestination: mocks.chooseMoveDestination,
    setWorkspaceRoot: mocks.setWorkspaceRoot,
    listDirectory: mocks.listDirectory,
    inspectPath: mocks.inspectPath,
    findWorkspaceRoot: mocks.findWorkspaceRoot,
    getWindowBootstrap: mocks.getWindowBootstrap,
    finishWindowStartup: vi.fn(async () => undefined),
    createWorkspaceWindow: mocks.createWorkspaceWindow,
    respondAppQuit: mocks.respondAppQuit,
    printCurrentWindow: mocks.printCurrentWindow,
    listenForOpenPath: vi.fn(async (handler: (path: string) => void) => {
      mocks.openPathHandler = handler;
      return () => undefined;
    }),
    listenForWorkspaceChanges: vi.fn(async (handler: typeof mocks.workspaceChangeHandler) => {
      mocks.workspaceChangeHandler = handler;
      return () => undefined;
    }),
    listenForWorkspaceWatchFailures: vi.fn(async (handler: typeof mocks.workspaceFailureHandler) => {
      mocks.workspaceFailureHandler = handler;
      return () => undefined;
    }),
    listenForWindowOpenFailures: vi.fn(async () => () => undefined),
    listenForAppQuitRequests: vi.fn(async (handler: typeof mocks.quitRequestHandler) => {
      mocks.quitRequestHandler = handler;
      return () => undefined;
    }),
    listenForAppQuitAborts: vi.fn(async (handler: typeof mocks.quitAbortHandler) => {
      mocks.quitAbortHandler = handler;
      return () => undefined;
    }),
    listenForPrintRequests: vi.fn(async (handler: typeof mocks.printRequestHandler) => {
      mocks.printRequestHandler = handler;
      return () => undefined;
    }),
    readTextFile: mocks.readTextFile,
    readSpreadsheet: mocks.readSpreadsheet,
    createDirectory: mocks.createDirectory,
    createMarkdownFile: mocks.createMarkdownFile,
    writeTextFile: mocks.writeTextFile,
    savePastedImages: mocks.savePastedImages,
    prepareHtmlPreview: mocks.prepareHtmlPreview,
    releaseHtmlPreview: mocks.releaseHtmlPreview,
    prepareTrash: mocks.prepareTrash,
    moveToTrash: mocks.moveToTrash,
    prepareWorkspaceMove: mocks.prepareWorkspaceMove,
    moveWorkspaceEntry: mocks.moveWorkspaceEntry,
    reconcileWorkspaceMove: mocks.reconcileWorkspaceMove,
    prepareWorkspaceRename: mocks.prepareWorkspaceRename,
    renameWorkspaceEntry: mocks.renameWorkspaceEntry,
    reconcileWorkspaceRename: mocks.reconcileWorkspaceRename,
    generateSystemThumbnail: mocks.generateSystemThumbnail,
    showEmbeddedQuickLook: mocks.showEmbeddedQuickLook,
    resizeEmbeddedQuickLook: mocks.resizeEmbeddedQuickLook,
    hideEmbeddedQuickLook: mocks.hideEmbeddedQuickLook,
    openQuickLook: vi.fn(async () => undefined),
    openInDefaultApp: vi.fn(async () => undefined),
    revealPath: mocks.revealPath,
  };
});

vi.mock('./lib/print', () => ({
  waitForPrintableAssets: mocks.waitForPrintableAssets,
}));

async function editCurrentDocument(value: string) {
  if (!screen.queryByRole('textbox', { name: 'editor' })) {
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
  }
  const editor = await screen.findByRole('textbox', { name: 'editor' });
  fireEvent.change(editor, { target: { value } });
  return editor;
}

async function beginMarkdownCreate(
  user: ReturnType<typeof userEvent.setup>,
  buttonName: string,
) {
  await user.click(screen.getByRole('button', { name: buttonName }));
  await user.click(screen.getByRole('menuitem', { name: '新建 Markdown' }));
}

async function beginFolderCreate(
  user: ReturnType<typeof userEvent.setup>,
  buttonName: string,
) {
  await user.click(screen.getByRole('button', { name: buttonName }));
  await user.click(screen.getByRole('menuitem', { name: '新建文件夹' }));
}

async function beginEntryRename(
  user: ReturnType<typeof userEvent.setup>,
  buttonName: RegExp | string,
) {
  await user.click(screen.getByRole('button', { name: buttonName }));
  await user.click(screen.getByRole('menuitem', { name: '重命名' }));
}

beforeEach(() => {
  localStorage.clear();
  mocks.desktop = false;
  mocks.closeHandler = undefined;
  mocks.focusHandler = undefined;
  mocks.openPathHandler = undefined;
  mocks.quitRequestHandler = undefined;
  mocks.quitAbortHandler = undefined;
  mocks.printRequestHandler = undefined;
  mocks.workspaceChangeHandler = undefined;
  mocks.workspaceFailureHandler = undefined;
  mocks.setWorkspaceRoot.mockReset();
  mocks.setWorkspaceRoot.mockImplementation(async (path: string) => path);
  mocks.inspectPath.mockReset();
  mocks.inspectPath.mockImplementation(async (path: string) => ({
    name: path.split('/').pop() ?? path,
    path,
    kind: path.endsWith('.pages') ? 'document' : (path.split('/').pop()?.includes('.') ? 'md' : 'folder'),
  }));
  mocks.findWorkspaceRoot.mockReset();
  mocks.findWorkspaceRoot.mockResolvedValue('/workspace');
  mocks.listDirectory.mockReset();
  mocks.listDirectory.mockImplementation(async (path: string) => {
    if (path === '/workspace') return [
      { name: 'docs', path: '/workspace/docs', kind: 'folder' },
      { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
    ];
    if (path === '/workspace/docs') return [
      { name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' },
      { name: 'report.pages', path: '/workspace/docs/report.pages', kind: 'document' },
    ];
    if (path === '/workspace/drafts') return [
      { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
    ];
    return [];
  });
  mocks.getWindowBootstrap.mockReset();
  mocks.getWindowBootstrap.mockResolvedValue({
    initialPath: '/workspace/docs/plan.md',
    sessionId: 'testprocess.0',
    restoreMode: 'none',
  });
  mocks.createWorkspaceWindow.mockReset();
  mocks.createWorkspaceWindow.mockResolvedValue('workspace-testprocess-1');
  mocks.respondAppQuit.mockReset();
  mocks.respondAppQuit.mockResolvedValue(undefined);
  mocks.printCurrentWindow.mockReset();
  mocks.printCurrentWindow.mockResolvedValue(undefined);
  mocks.waitForPrintableAssets.mockReset();
  mocks.waitForPrintableAssets.mockResolvedValue({ timedOut: false, failedImages: [] });
  mocks.readTextFile.mockReset();
  mocks.readSpreadsheet.mockReset();
  mocks.readSpreadsheet.mockResolvedValue({
    version: 'sheet-v1',
    sheets: [{
      name: 'Data', index: 0, visible: true,
      startRow: 0, startColumn: 0, endRow: 0, endColumn: 0,
    }],
    cells: [{ sheetIndex: 0, row: 0, column: 0, kind: 'string', displayValue: 'value' }],
  });
  mocks.createDirectory.mockReset();
  mocks.createDirectory.mockImplementation(async (parentPath: string, name: string) => ({
    name: name.trim(),
    path: `${parentPath}/${name.trim()}`,
    kind: 'folder',
  }));
  mocks.createMarkdownFile.mockReset();
  mocks.createMarkdownFile.mockImplementation(async (parentPath: string, name: string) => {
    const trimmed = name.trim();
    const fileName = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
    return {
      entry: { name: fileName, path: `${parentPath}/${fileName}`, kind: 'md' },
      snapshot: { content: '', version: 'empty-v1' },
    };
  });
  mocks.writeTextFile.mockReset();
  mocks.writeTextFile.mockResolvedValue('saved-version');
  mocks.savePastedImages.mockReset();
  mocks.savePastedImages.mockResolvedValue(['assets/screenshot-test.png']);
  mocks.prepareHtmlPreview.mockReset();
  mocks.prepareHtmlPreview.mockImplementation(async (path: string) => ({
    token: 'preview-token',
    documentPath: path,
    workspaceGeneration: 1,
  }));
  mocks.releaseHtmlPreview.mockReset();
  mocks.releaseHtmlPreview.mockResolvedValue(undefined);
  mocks.prepareTrash.mockReset();
  mocks.prepareTrash.mockImplementation(async (path: string) => ({
    originalPath: path,
    workspaceGeneration: 1,
    parentIdentity: '1:2',
    targetIdentity: '1:3',
    isDir: false,
  }));
  mocks.moveToTrash.mockReset();
  mocks.moveToTrash.mockImplementation(async (candidate: { originalPath: string }) => ({
    originalPath: candidate.originalPath,
    trashedPath: `/Users/test/.Trash/${candidate.originalPath.split('/').pop()}`,
  }));
  mocks.chooseFolder.mockReset();
  mocks.chooseFolder.mockResolvedValue(null);
  mocks.chooseMoveDestination.mockReset();
  mocks.chooseMoveDestination.mockResolvedValue(null);
  mocks.prepareWorkspaceMove.mockReset();
  mocks.prepareWorkspaceMove.mockImplementation(async (sourcePath: string, destinationDirectory: string) => ({
    sourcePath,
    destinationDirectory,
    destinationPath: `${destinationDirectory}/${sourcePath.split('/').pop()}`,
    workspaceGeneration: 1,
    sourceParentIdentity: '1:10',
    sourceIdentity: '1:11',
    destinationIdentity: '1:12',
    sourceIsDirectory: sourcePath.endsWith('.pages') || sourcePath.endsWith('/docs'),
    sourceIsBundle: sourcePath.endsWith('.pages'),
  }));
  mocks.moveWorkspaceEntry.mockReset();
  mocks.moveWorkspaceEntry.mockImplementation(async (candidate: {
    sourcePath: string;
    destinationPath: string;
    sourceIsDirectory?: boolean;
  }) => ({
    originalPath: candidate.sourcePath,
    movedPath: candidate.destinationPath,
    entry: {
      name: candidate.destinationPath.split('/').pop()!,
      path: candidate.destinationPath,
      kind: candidate.sourcePath.endsWith('.pages')
        ? 'document'
        : candidate.sourcePath.endsWith('.xlsx')
          ? 'spreadsheet'
          : candidate.sourcePath.endsWith('.png')
            ? 'image'
            : candidate.sourceIsDirectory ? 'folder' : 'md',
    },
  }));
  mocks.reconcileWorkspaceMove.mockReset();
  mocks.reconcileWorkspaceMove.mockResolvedValue({ outcome: 'source' });
  mocks.prepareWorkspaceRename.mockReset();
  mocks.prepareWorkspaceRename.mockImplementation(async (sourcePath: string, newName: string) => ({
    sourcePath,
    destinationPath: `${sourcePath.slice(0, sourcePath.lastIndexOf('/'))}/${newName}`,
    workspaceGeneration: 1,
    parentIdentity: '1:10',
    sourceIdentity: '1:11',
    sourceIsDirectory: sourcePath.endsWith('.pages') || sourcePath.endsWith('/docs'),
    sourceIsBundle: sourcePath.endsWith('.pages'),
  }));
  mocks.renameWorkspaceEntry.mockReset();
  mocks.renameWorkspaceEntry.mockImplementation(async (candidate: {
    sourcePath: string;
    destinationPath: string;
    sourceIsDirectory?: boolean;
  }) => ({
    originalPath: candidate.sourcePath,
    renamedPath: candidate.destinationPath,
    entry: {
      name: candidate.destinationPath.split('/').pop()!,
      path: candidate.destinationPath,
      kind: candidate.sourcePath.endsWith('.pages')
        ? 'document'
        : candidate.sourcePath.endsWith('.xlsx')
          ? 'spreadsheet'
          : candidate.sourcePath.endsWith('.png')
            ? 'image'
            : candidate.sourceIsDirectory ? 'folder' : 'md',
    },
  }));
  mocks.reconcileWorkspaceRename.mockReset();
  mocks.reconcileWorkspaceRename.mockResolvedValue({ outcome: 'source' });
  mocks.closeWindow.mockReset();
  mocks.destroyWindow.mockReset();
  mocks.destroyWindow.mockResolvedValue(undefined);
  mocks.generateSystemThumbnail.mockReset();
  mocks.generateSystemThumbnail.mockResolvedValue({
    mimeType: 'image/png',
    dataBase64: 'cG5n',
    width: 800,
    height: 600,
  });
  mocks.showEmbeddedQuickLook.mockReset();
  mocks.showEmbeddedQuickLook.mockResolvedValue(undefined);
  mocks.resizeEmbeddedQuickLook.mockReset();
  mocks.resizeEmbeddedQuickLook.mockResolvedValue(undefined);
  mocks.hideEmbeddedQuickLook.mockReset();
  mocks.hideEmbeddedQuickLook.mockResolvedValue(undefined);
  mocks.revealPath.mockReset();
  mocks.revealPath.mockResolvedValue(undefined);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('autosave transition protection', () => {
  async function readyScreenshotEditor() {
    await screen.findByText('workspace / plan.md');
    await waitFor(() => expect((screen.getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(false));
    return editCurrentDocument('# initial disk');
  }
  function pasteScreenshot() {
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'capture.png', { type: 'image/png' });
    fireEvent.paste(screen.getByRole('textbox', { name: 'editor' }), { clipboardData: {
      items: [{ kind: 'file', type: image.type, getAsFile: () => image }], files: [image],
    } });
  }

  it('waits for screenshot insertion before closing and saves the image reference', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# initial disk', version: 'v1' });
    const imageWrite = deferred<string[]>();
    mocks.savePastedImages.mockReturnValue(imageWrite.promise);
    render(<App />);
    await readyScreenshotEditor();
    pasteScreenshot();
    await waitFor(() => expect(mocks.savePastedImages).toHaveBeenCalledOnce());
    const preventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.destroyWindow).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    await act(async () => imageWrite.resolve(['assets/screenshot-test.png']));
    await waitFor(() => expect(mocks.destroyWindow).toHaveBeenCalledOnce());
    expect(mocks.writeTextFile).toHaveBeenCalledWith('/workspace/docs/plan.md', '![截图](assets/screenshot-test.png) initial disk', 'v1');
    expect(mocks.savePastedImages).toHaveBeenCalledWith('/workspace/docs/plan.md', expect.any(Number), [{ mimeType: 'image/png', bytes: [137, 80, 78, 71] }]);
  });

  it('waits for screenshot insertion before Command-S flushes', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# initial disk', version: 'v1' });
    const imageWrite = deferred<string[]>();
    mocks.savePastedImages.mockReturnValue(imageWrite.promise);
    render(<App />);
    await readyScreenshotEditor();
    pasteScreenshot();
    await waitFor(() => expect(mocks.savePastedImages).toHaveBeenCalledOnce());
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    await act(async () => imageWrite.resolve(['assets/screenshot-test.png']));
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledWith('/workspace/docs/plan.md', '![截图](assets/screenshot-test.png) initial disk', 'v1'));
  });

  it('keeps the draft and releases the editor after a screenshot write error', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# initial disk', version: 'v1' });
    mocks.savePastedImages.mockRejectedValue(new Error('PERMISSION_DENIED'));
    render(<App />);
    await readyScreenshotEditor();
    pasteScreenshot();
    await screen.findByText('图片粘贴失败：PERMISSION_DENIED');
    const editor = screen.getByRole('textbox', { name: 'editor' }) as HTMLTextAreaElement;
    expect(editor.value).toBe('# initial disk');
    expect(editor.disabled).toBe(false);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('autosaves the browser draft before switching files without a discard dialog', async () => {
    const user = userEvent.setup();
    render(<App />);

    await editCurrentDocument('# browser draft');
    await user.click(screen.getByRole('button', { name: /product-notes\.md$/ }));
    await waitFor(() => expect(screen.getByText('project / product-notes.md')).toBeTruthy());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('flushes before workspace changes and close without the old discard dialog', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# initial disk', version: 'v1' });
    mocks.chooseFolder.mockResolvedValue('/other');
    mocks.destroyWindow.mockRejectedValueOnce(new Error('native destroy failed'));
    const user = userEvent.setup();
    render(<App />);

    await editCurrentDocument('# local draft');
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await screen.findByRole('button', { name: '在 OTHER 根目录新建' });
    expect(mocks.writeTextFile).toHaveBeenCalledWith('/workspace/docs/plan.md', '# local draft', 'v1');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => mocks.openPathHandler?.('/workspace/docs/second.md'));
    await screen.findByText('workspace / second.md');
    await editCurrentDocument('# close draft');
    localStorage.setItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY, 'otherprocess.0');

    const preventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.destroyWindow).toHaveBeenCalledOnce());
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('关闭失败：native destroy failed')).toBeTruthy());
    expect(readWorkspaceSession('testprocess.0')?.rootPath).toBe('/workspace');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('lets a clean window use the native close without entering the save guard', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# clean disk', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');

    const preventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault }));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    expect(mocks.destroyWindow).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('keeps the window and local draft when a failed save discard is cancelled', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.writeTextFile.mockRejectedValueOnce(new Error('disk full'));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# unsaved local draft');

    const preventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(await screen.findByText('关闭 LocalView前无法保存')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '继续编辑' }));

    expect(mocks.destroyWindow).not.toHaveBeenCalled();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'editor' }) as HTMLTextAreaElement).value)
      .toBe('# unsaved local draft');
  });

  it('restores unload protection when an approved discard cannot destroy the window', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.writeTextFile.mockRejectedValueOnce(new Error('disk full'));
    mocks.destroyWindow.mockRejectedValueOnce(new Error('destroy denied'));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# local draft survives');

    const preventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault }));
    await user.click(await screen.findByRole('button', { name: '放弃修改并关闭 LocalView' }));
    await waitFor(() => expect(mocks.destroyWindow).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText('关闭失败：destroy denied')).toBeTruthy());

    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'editor' }) as HTMLTextAreaElement).value)
      .toBe('# local draft survives');
  });
});

describe('external disk changes', () => {
  it('replaces both preview state and the mounted editor for a clean document', async () => {
    mocks.desktop = true;
    mocks.readTextFile
      .mockResolvedValueOnce({ content: '# old disk', version: 'v1' })
      .mockResolvedValue({ content: '# new disk', version: 'v2' });

    let poll: (() => Promise<void>) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (timeout === 5000) poll = handler as () => Promise<void>;
      return 1;
    }) as typeof window.setInterval);

    render(<App />);

    await screen.findByRole('heading', { name: 'old disk' });
    fireEvent.click(screen.getByRole('button', { name: '分栏' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# old disk'));
    expect(poll).toBeTypeOf('function');

    await act(async () => {
      await poll?.();
    });

    await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# new disk'));
    expect(screen.getByRole('heading', { name: 'new disk' })).toBeTruthy();
  });

  it('keeps local edits on conflict until the user chooses a resolution', async () => {
    mocks.desktop = true;
    mocks.readTextFile
      .mockResolvedValueOnce({ content: '# disk v1', version: 'v1' })
      .mockResolvedValue({ content: '# disk v2', version: 'v2' });
    mocks.writeTextFile.mockRejectedValue(new Error('EXTERNAL_CHANGE: changed outside'));

    const user = userEvent.setup();
    render(<App />);
    await editCurrentDocument('# local edits');

    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '保留本地修改' }));
    expect(mocks.writeTextFile).toHaveBeenCalledOnce();
    expect(screen.getByText('磁盘已变更')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# local edits');

    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '重新载入磁盘版本' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# disk v2'));
  });

  it('allows retrying file navigation after choosing to continue editing a conflict', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk v1', version: 'v1' });
    mocks.writeTextFile.mockRejectedValue(new Error('EXTERNAL_CHANGE: changed outside'));
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# local edits');
    await user.click(screen.getByRole('button', { name: 'report.pages' }));
    await user.click(await screen.findByRole('button', { name: '继续编辑' }));

    await user.click(screen.getByRole('button', { name: 'report.pages' }));
    expect(await screen.findByRole('button', { name: '放弃修改并打开其他文件' })).toBeTruthy();
  });
});

describe('Markdown printing', () => {
  it('prints the rendered latest unsaved snapshot without saving or changing mode', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const editor = await screen.findByRole('textbox', { name: 'editor' }, { timeout: 5000 });
    fireEvent.change(editor, { target: { value: '# Unsaved print title\n\n**rendered**' } });

    await user.click(screen.getByRole('button', { name: '打印' }));
    await waitFor(() => expect(mocks.printCurrentWindow).toHaveBeenCalledOnce());

    const printRoot = mocks.waitForPrintableAssets.mock.calls[0]?.[0] as HTMLElement;
    expect(printRoot.querySelector('h1')?.textContent).toBe('Unsaved print title');
    expect(printRoot.querySelector('strong')?.textContent).toBe('rendered');
    expect(printRoot.textContent).not.toContain('# Unsaved print title');
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '编辑' }).className).toContain('active');
    expect(editor).toHaveProperty('value', '# Unsaved print title\n\n**rendered**');
    expect(document.querySelector('.markdown-print-surface')).toBeTruthy();

    act(() => window.dispatchEvent(new Event('afterprint')));
    await waitFor(() => expect(document.querySelector('.markdown-print-surface')).toBeNull());
  });

  it('deduplicates native menu and Command-P while one immutable print job is preparing', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# Native print', version: 'v1' });
    const readiness = deferred<{ timedOut: boolean; failedImages: string[] }>();
    mocks.waitForPrintableAssets.mockReturnValue(readiness.promise);
    render(<App />);

    await screen.findByText('workspace / plan.md');
    await waitFor(() => expect(mocks.printRequestHandler).toBeTypeOf('function'));
    act(() => mocks.printRequestHandler?.());
    await waitFor(
      () => expect(mocks.waitForPrintableAssets).toHaveBeenCalledOnce(),
      { timeout: 5000 },
    );

    act(() => mocks.printRequestHandler?.());
    const shortcut = new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true);
    expect(mocks.printCurrentWindow).not.toHaveBeenCalled();

    await act(async () => readiness.resolve({ timedOut: false, failedImages: [] }));
    await waitFor(() => expect(mocks.printCurrentWindow).toHaveBeenCalledOnce());
    expect(mocks.waitForPrintableAssets).toHaveBeenCalledOnce();
  });

  it('captures Command-P but fails closed for non-Markdown documents', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /index\.html$/ }));
    await screen.findByText('project / index.html');

    const shortcut = new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(shortcut));

    expect(shortcut.defaultPrevented).toBe(true);
    expect(mocks.printCurrentWindow).not.toHaveBeenCalled();
    expect(document.querySelector('.markdown-print-surface')).toBeNull();
    expect(await screen.findByText('当前仅支持打印 Markdown 文件')).toBeTruthy();
  });

  it('cleans up the print surface and releases interactions when native dispatch fails', async () => {
    mocks.printCurrentWindow.mockRejectedValueOnce(new Error('native print failed'));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: '打印' }));
    expect(await screen.findByText('无法打开打印设置：native print failed')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.markdown-print-surface')).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '打印' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: '预览' }).className).toContain('active');
  });
});

describe('default preview mode', () => {
  it('opens Markdown, HTML, and text in Preview and resets manual Edit on file changes', async () => {
    window.localStorage.setItem('localview.view-modes', JSON.stringify({ md: 'edit', html: 'split', text: 'edit' }));
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('button', { name: '预览' }).className).toContain('active');
    expect(screen.queryByRole('textbox', { name: 'editor' })).toBeNull();
    expect(screen.queryByTestId('mock-markdown-context')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Local Folder Viewer' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect((await screen.findByRole('textbox', { name: 'editor' }))
      .closest<HTMLElement>('.editor-pane')?.dataset.markdownPresentation).toBe('live');
    expect(screen.getByTestId('mock-markdown-context')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /product-notes\.md$/ }));
    await screen.findByText('project / product-notes.md');
    expect(screen.getByRole('button', { name: '预览' }).className).toContain('active');
    expect(screen.queryByRole('textbox', { name: 'editor' })).toBeNull();
    expect(screen.queryByTestId('mock-markdown-context')).toBeNull();

    await user.click(screen.getByRole('button', { name: /index\.html$/ }));
    await screen.findByText('project / index.html');
    expect(screen.getByRole('button', { name: '预览' }).className).toContain('active');
    expect(screen.queryByRole('textbox', { name: 'editor' })).toBeNull();
    const htmlFrame = screen.getByTitle('index.html');
    expect(htmlFrame.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
    expect(htmlFrame.getAttribute('srcdoc')).toContain("connect-src 'none'");
    expect(htmlFrame.getAttribute('srcdoc')).toContain("form-action 'none'");
    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(await screen.findByRole('textbox', { name: 'editor' })).toBeTruthy();
    expect(screen.queryByTestId('mock-markdown-context')).toBeNull();

    await user.click(screen.getByRole('button', { name: /style\.css$/ }));
    await screen.findByText('project / style.css');
    expect(screen.getByRole('button', { name: '预览' }).className).toContain('active');
    expect(screen.queryByRole('textbox', { name: 'editor' })).toBeNull();
    expect(document.querySelector('.code-preview')?.textContent).toContain('font-family: system-ui');
  });

  it('still supports explicit Edit and Split modes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(await screen.findByRole('textbox', { name: 'editor' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Local Folder Viewer' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '分栏' }));
    const markdownTextbox = screen.getByRole('textbox', { name: 'editor' });
    expect(markdownTextbox.closest<HTMLElement>('.editor-pane')?.dataset.markdownPresentation)
      .toBe('source');
    const markdownEditor = markdownTextbox.closest('.editor-surface');
    const markdownPreview = screen.getByRole('heading', { name: 'Local Folder Viewer' }).closest('.preview-pane');
    expect(markdownPreview?.nextElementSibling).toBe(markdownEditor);

    await user.click(screen.getByRole('button', { name: '预览' }));
    expect(screen.queryByRole('textbox', { name: 'editor' })).toBeNull();
    expect((markdownEditor as HTMLElement).hidden).toBe(true);
    expect((markdownTextbox as HTMLTextAreaElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByRole('textbox', { name: 'editor' })).toBe(markdownTextbox);

    await user.click(screen.getByRole('button', { name: /index\.html$/ }));
    await screen.findByText('project / index.html');
    await user.click(screen.getByRole('button', { name: '分栏' }));
    const htmlTextbox = screen.getByRole('textbox', { name: 'editor' });
    expect(htmlTextbox.closest('.editor-pane')?.getAttribute('data-markdown-presentation')).toBeNull();
    const htmlEditor = htmlTextbox.closest('.editor-surface');
    const htmlPreview = screen.getByTitle('index.html').closest('.html-pane');
    expect(htmlPreview?.nextElementSibling).toBe(htmlEditor);
  });
});

describe('Markdown file creation', () => {
  it('shows root and sibling folder create buttons and simulates browser creation honestly', async () => {
    const user = userEvent.setup();
    render(<App />);

    const rootCreate = screen.getByRole('button', { name: '在 PROJECT 根目录新建' });
    const folderCreate = screen.getByRole('button', { name: '在 docs 中新建' });
    const folderRow = folderCreate.closest('.tree-row');
    expect(folderRow?.querySelectorAll(':scope > button')).toHaveLength(0);
    expect(folderRow?.querySelectorAll(':scope > .tree-row-main')).toHaveLength(1);
    expect(folderRow?.querySelectorAll('.tree-row-actions button')).toHaveLength(2);
    expect(folderRow?.querySelector('.tree-row-main')).toBeTruthy();

    await user.click(rootCreate);
    await user.click(screen.getByRole('menuitem', { name: '新建 Markdown' }));
    const input = screen.getByRole('textbox', { name: '在 project 中新建 Markdown 文件' });
    expect(document.activeElement).toBe(input);
    await user.type(input, 'browser-note{Enter}');

    const created = await screen.findByRole('button', { name: /browser-note\.md$/ });
    expect(created.className).toContain('active');
    expect(screen.getByRole('button', { name: '编辑' }).className).toContain('active');
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '');
    expect(screen.getByRole('textbox', { name: 'editor' })
      .closest<HTMLElement>('.editor-pane')?.dataset.markdownPresentation).toBe('live');
    expect(screen.getByText('已保存')).toBeTruthy();
    expect(await screen.findByText(/browser-note\.md；浏览器 Demo 未写入磁盘/)).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /browser-note\.md$/ }).className).toContain('active');
    expect(mocks.listDirectory).not.toHaveBeenCalled();
    expect(mocks.createMarkdownFile).not.toHaveBeenCalled();
  });

  it('cancels inline creation with Escape and rejects browser duplicates without Tauri', async () => {
    const user = userEvent.setup();
    render(<App />);

    await beginMarkdownCreate(user, '在 docs 中新建');
    const nestedInput = screen.getByRole('textbox', { name: '在 docs 中新建 Markdown 文件' });
    await user.type(nestedInput, 'cancelled{Escape}');
    expect(screen.queryByRole('textbox', { name: '在 docs 中新建 Markdown 文件' })).toBeNull();
    expect(screen.queryByRole('button', { name: /cancelled\.md$/ })).toBeNull();

    await beginMarkdownCreate(user, '在 PROJECT 根目录新建');
    const rootInput = screen.getByRole('textbox', { name: '在 project 中新建 Markdown 文件' });
    await user.type(rootInput, 'README.md{Enter}');
    expect(await screen.findByText(/同名 Markdown 文件已存在/)).toBeTruthy();
    expect(rootInput).toHaveProperty('value', 'README.md');
    expect(mocks.createMarkdownFile).not.toHaveBeenCalled();
  });

  it('does not expose root creation before a desktop workspace is open', async () => {
    mocks.desktop = true;
    mocks.getWindowBootstrap.mockResolvedValue({
      initialPath: null,
      sessionId: 'testprocess.empty',
      restoreMode: 'none',
    });
    render(<App />);

    await waitFor(() => expect(mocks.getWindowBootstrap).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: /根目录新建/ })).toBeNull();
  });

  it('loads a collapsed folder, creates once, selects Edit, and saves with the initial version', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginMarkdownCreate(user, '在 drafts 中新建');
    const input = await screen.findByRole('textbox', { name: '在 drafts 中新建 Markdown 文件' });
    expect(mocks.listDirectory).toHaveBeenCalledWith('/workspace/drafts');
    expect(screen.getByRole('button', { name: /older\.md$/ })).toBeTruthy();
    mocks.listDirectory.mockImplementation(async (path: string) => path === '/workspace/drafts'
      ? [
          { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
          { name: 'nested-note.md', path: '/workspace/drafts/nested-note.md', kind: 'md' },
        ]
      : []);

    await user.type(input, 'nested-note.md');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.createMarkdownFile).toHaveBeenCalledTimes(1));
    expect(mocks.createMarkdownFile).toHaveBeenCalledWith('/workspace/drafts', 'nested-note.md');
    const created = await screen.findByRole('button', { name: /nested-note\.md$/ });
    expect(created.className).toContain('active');
    expect((await screen.findByRole('button', { name: '编辑' })).className).toContain('active');
    expect(screen.getByText('已保存')).toBeTruthy();

    const editor = await screen.findByRole('textbox', { name: 'editor' });
    fireEvent.change(editor, { target: { value: '# created' } });
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledWith(
      '/workspace/drafts/nested-note.md',
      '# created',
      'empty-v1',
    ));
  });

  it('keeps the draft and current file when a duplicate creation fails', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    mocks.createMarkdownFile.mockRejectedValue(new Error('MARKDOWN_FILE_EXISTS'));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    await user.type(input, 'plan{Enter}');

    expect(await screen.findByText(/同名 Markdown 文件已存在/)).toBeTruthy();
    expect(input).toHaveProperty('value', 'plan');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /\/plan\.md$/ })).toBeNull();
  });

  it('autosaves the current document and creates once without a discard prompt', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# unsaved');

    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    await user.type(input, 'guarded{Enter}');
    await waitFor(() => expect(mocks.createMarkdownFile).toHaveBeenCalledTimes(1));
    expect(mocks.writeTextFile).toHaveBeenCalledWith('/workspace/docs/plan.md', '# unsaved', 'plan-v1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByRole('button', { name: /guarded\.md$/ })).toBeTruthy();
  });

  it('does not inject a completed old-workspace creation into the new tree', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    mocks.chooseFolder.mockResolvedValue('/other');
    let resolveCreate: ((value: {
      entry: { name: string; path: string; kind: 'md' };
      snapshot: { content: string; version: string };
    }) => void) | undefined;
    mocks.createMarkdownFile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    await user.type(input, 'late{Enter}');
    await waitFor(() => expect(mocks.createMarkdownFile).toHaveBeenCalledOnce());

    expect(screen.getByRole('button', { name: '打开文件夹' })).toHaveProperty('disabled', true);
    await act(async () => resolveCreate?.({
      entry: { name: 'late.md', path: '/workspace/late.md', kind: 'md' },
      snapshot: { content: '', version: 'empty-v1' },
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: '打开文件夹' })).toHaveProperty('disabled', false));
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await screen.findByRole('button', { name: '在 OTHER 根目录新建' });
    expect(mocks.setWorkspaceRoot).toHaveBeenCalledWith('/other');
    expect(screen.queryByRole('button', { name: /late\.md$/ })).toBeNull();
  });

  it('ignores stale lazy-folder responses after switching workspaces', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    mocks.chooseFolder.mockResolvedValue('/other');
    let resolveDrafts: ((value: Array<{ name: string; path: string; kind: 'md' }>) => void) | undefined;
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/workspace/drafts') return new Promise((resolve) => { resolveDrafts = resolve; });
      return defaultList?.(path);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginMarkdownCreate(user, '在 drafts 中新建');
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledWith('/workspace/drafts'));
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await screen.findByRole('button', { name: '在 OTHER 根目录新建' });
    await act(async () => resolveDrafts?.([
      { name: 'stale.md', path: '/workspace/drafts/stale.md', kind: 'md' },
    ]));

    expect(screen.queryByRole('button', { name: /stale\.md$/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /drafts 中新建 Markdown/ })).toBeNull();
  });
});

describe('folder creation and tree action menus', () => {
  it('exposes compact create/full menus and restores the trigger focus with Escape', async () => {
    const user = userEvent.setup();
    render(<App />);

    const rootCreate = screen.getByRole('button', { name: '在 PROJECT 根目录新建' });
    await user.click(rootCreate);
    expect(screen.getByRole('menuitem', { name: '新建 Markdown' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '新建文件夹' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '移到废纸篓' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(rootCreate));

    const docs = screen.getByRole('button', { name: 'docs' });
    fireEvent.contextMenu(docs, { clientX: 80, clientY: 100 });
    expect(screen.getByRole('menuitem', { name: '新建 Markdown' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '新建文件夹' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '移到废纸篓' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(docs));

    const readme = screen.getByRole('button', { name: 'README.md' });
    fireEvent.contextMenu(readme, { clientX: 80, clientY: 100 });
    expect(screen.queryByRole('menuitem', { name: '新建 Markdown' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '新建文件夹' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '移到废纸篓' })).toBeTruthy();
  });

  it('creates a browser folder in memory without changing or saving the dirty document', async () => {
    const user = userEvent.setup();
    render(<App />);
    const editor = await editCurrentDocument('# dirty browser draft');

    await beginFolderCreate(user, '在 PROJECT 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 project 中新建文件夹' });
    await user.type(input, '资料{Enter}');

    const created = await screen.findByRole('button', { name: '资料' });
    await waitFor(() => expect(document.activeElement).toBe(created));
    expect(screen.getByText('project / README.md')).toBeTruthy();
    expect(editor).toHaveProperty('value', '# dirty browser draft');
    expect(editor).toHaveProperty('disabled', false);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(mocks.createDirectory).not.toHaveBeenCalled();
    mocks.listDirectory.mockClear();
    await user.click(created);
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });

  it('keeps CodeMirror editable while desktop folder creation is in flight', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const creation = deferred<{ name: string; path: string; kind: 'folder' }>();
    mocks.createDirectory.mockReturnValueOnce(creation.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    const editor = await editCurrentDocument('# unsaved folder test');

    await beginFolderCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建文件夹' });
    await user.type(input, '新目录{Enter}');
    await waitFor(() => expect(mocks.createDirectory).toHaveBeenCalledWith('/workspace', '新目录'));

    expect(editor).toHaveProperty('disabled', false);
    expect(editor).toHaveProperty('value', '# unsaved folder test');
    expect(screen.getByRole('button', { name: '打开文件夹' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '工作区菜单' })).toHaveProperty('disabled', true);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();

    await act(async () => creation.resolve({ name: '新目录', path: '/workspace/新目录', kind: 'folder' }));
    const created = await screen.findByRole('button', { name: '新目录' });
    await waitFor(() => expect(document.activeElement).toBe(created));
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(editor).toHaveProperty('value', '# unsaved folder test');
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('keeps duplicate and reserved folder drafts invalid and focused', async () => {
    const user = userEvent.setup();
    render(<App />);

    await beginFolderCreate(user, '在 PROJECT 根目录新建');
    const duplicate = screen.getByRole('textbox', { name: '在 project 中新建文件夹' });
    await user.type(duplicate, 'docs{Enter}');
    expect(await screen.findByText('同名文件或文件夹已存在')).toBeTruthy();
    expect(duplicate).toHaveProperty('value', 'docs');
    expect(duplicate.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(duplicate));

    await user.type(duplicate, '{Escape}');
    await beginFolderCreate(user, '在 PROJECT 根目录新建');
    const reserved = screen.getByRole('textbox', { name: '在 project 中新建文件夹' });
    await user.type(reserved, '.DS_Store{Enter}');
    expect(await screen.findByText('该名称由 LocalView 或系统保留')).toBeTruthy();
    expect(reserved.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.createDirectory).not.toHaveBeenCalled();
  });

  it('does not describe a reconciled desktop duplicate as newly created', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    mocks.createDirectory.mockRejectedValueOnce(new Error('DIRECTORY_ENTRY_EXISTS'));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginFolderCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建文件夹' });
    await user.type(input, 'docs{Enter}');

    expect(await screen.findByText('同名文件或文件夹已存在；目录已刷新，已确认同名项存在')).toBeTruthy();
    expect(screen.queryByText(/已创建并刷新/)).toBeNull();
    expect(input).toHaveProperty('value', 'docs');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('reconciles an uncertain desktop result and focuses the discovered folder', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    mocks.createDirectory.mockRejectedValueOnce(new Error('CREATE_DIRECTORY_RESULT_UNCERTAIN'));
    const defaultList = mocks.listDirectory.getMockImplementation();
    let reconcile = false;
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/workspace' && reconcile) return Promise.resolve([
        { name: 'docs', path: '/workspace/docs', kind: 'folder' },
        { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
        { name: 'recovered', path: '/workspace/recovered', kind: 'folder' },
      ]);
      return defaultList?.(path);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    reconcile = true;

    await beginFolderCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建文件夹' });
    await user.type(input, 'recovered{Enter}');

    expect(await screen.findByText('已创建并刷新目录')).toBeTruthy();
    const recovered = screen.getByRole('button', { name: 'recovered' });
    await waitFor(() => expect(document.activeElement).toBe(recovered));
    expect(screen.queryByRole('textbox', { name: /新建文件夹/ })).toBeNull();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
  });

  it('uses the focused tree folder for Command-Delete instead of the preview selection', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    const drafts = screen.getByRole('button', { name: 'drafts' });
    drafts.focus();

    fireEvent.keyDown(drafts, { key: 'Backspace', metaKey: true });
    expect(await screen.findByText(/“drafts”及其中的内容/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '移到废纸篓' }));

    await waitFor(() => expect(mocks.prepareTrash).toHaveBeenCalledWith('/workspace/drafts'));
    expect(mocks.prepareTrash).not.toHaveBeenCalledWith('/workspace/docs/plan.md');
    expect(screen.queryByRole('button', { name: 'drafts' })).toBeNull();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'plan.md' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '工作区菜单' })));
  });

  it('waits to close and cancels application quit while folder creation is in flight', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const creation = deferred<{ name: string; path: string; kind: 'folder' }>();
    mocks.createDirectory.mockReturnValueOnce(creation.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await beginFolderCreate(user, '在 WORKSPACE 根目录新建');
    await user.type(
      screen.getByRole('textbox', { name: '在 workspace 中新建文件夹' }),
      'slow{Enter}',
    );
    await waitFor(() => expect(mocks.createDirectory).toHaveBeenCalledOnce());

    const preventDefault = vi.fn();
    act(() => mocks.closeHandler?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.destroyWindow).not.toHaveBeenCalled();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    act(() => mocks.quitRequestHandler?.({ generation: 44 }));
    await waitFor(() => expect(mocks.respondAppQuit).toHaveBeenCalledWith(44, 'cancel'));

    await act(async () => creation.resolve({ name: 'slow', path: '/workspace/slow', kind: 'folder' }));
    await waitFor(() => expect(mocks.destroyWindow).toHaveBeenCalledOnce());
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });
});

describe('workspace transition and folder preparation races', () => {
  it('deduplicates an unloaded folder preparation and focuses the one resulting draft', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    const pending = deferred<Array<{ name: string; path: string; kind: 'md' }>>();
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => (
      path === '/workspace/drafts' ? pending.promise : defaultList?.(path)
    ));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    const create = screen.getByRole('button', { name: '在 drafts 中新建' });
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('menuitem', { name: '新建 Markdown' }));
    fireEvent.click(create);
    expect(mocks.listDirectory.mock.calls.filter(([path]) => path === '/workspace/drafts')).toHaveLength(1);
    expect(create.getAttribute('aria-busy')).toBe('true');

    await act(async () => pending.resolve([
      { name: 'z-last.md', path: '/workspace/drafts/z-last.md', kind: 'md' },
      { name: 'a-first.md', path: '/workspace/drafts/a-first.md', kind: 'md' },
    ]));
    const input = await screen.findByRole('textbox', { name: '在 drafts 中新建 Markdown 文件' });
    expect(document.activeElement).toBe(input);
    const fileButtons = screen.getAllByRole('button').filter((button) => /(?:a-first|z-last)\.md/.test(button.textContent ?? ''));
    expect(fileButtons.map((button) => button.textContent)).toEqual(['a-first.md', 'z-last.md']);
    expect(screen.queryByText('M↓')).toBeNull();
    await user.type(input, 'kept');
    expect(input).toHaveProperty('value', 'kept');
  });

  it('cleans a rejected folder preparation so the next click can retry', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    const defaultList = mocks.listDirectory.getMockImplementation();
    let attempts = 0;
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path !== '/workspace/drafts') return defaultList?.(path);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('temporary directory failure'))
        : Promise.resolve([{ name: 'retry.md', path: '/workspace/drafts/retry.md', kind: 'md' }]);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginMarkdownCreate(user, '在 drafts 中新建');
    expect(await screen.findByText('temporary directory failure')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '在 drafts 中新建' })).toHaveProperty('disabled', false));
    await beginMarkdownCreate(user, '在 drafts 中新建');

    const input = await screen.findByRole('textbox', { name: '在 drafts 中新建 Markdown 文件' });
    expect(attempts).toBe(2);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('button', { name: 'retry.md' })).toBeTruthy();
  });

  it('keeps old content and draft stable while locked, then commits the new workspace once', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    mocks.chooseFolder.mockResolvedValue('/other');
    const otherList = deferred<Array<{ name: string; path: string; kind: 'md' }>>();
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => path === '/other' ? otherList.promise : defaultList?.(path));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    await user.type(input, 'stable draft');

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => expect(screen.getByRole('complementary').getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'plan' })).toBeTruthy();
    expect(input).toHaveProperty('value', 'stable draft');
    expect(input).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '编辑' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '在 Finder 中显示' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(mocks.writeTextFile).not.toHaveBeenCalled();

    await act(async () => otherList.resolve([{ name: 'next.md', path: '/other/next.md', kind: 'md' }]));
    expect(await screen.findByRole('button', { name: '在 OTHER 根目录新建' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /workspace 中新建/ })).toBeNull();
    expect(screen.getByRole('complementary').getAttribute('aria-busy')).toBe('false');
  });

  it('rolls backend root back and preserves the draft value/focus when preparation fails', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    mocks.chooseFolder.mockResolvedValue('/broken');
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => path === '/broken'
      ? Promise.reject(new Error('cannot list broken root'))
      : defaultList?.(path));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.setWorkspaceRoot.mockClear();
    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    await user.type(input, 'recover me');

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(await screen.findByText('cannot list broken root')).toBeTruthy();
    expect(mocks.setWorkspaceRoot.mock.calls.map(([path]) => path)).toEqual(['/broken', '/workspace']);
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(input).toHaveProperty('value', 'recover me');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('clears an untrusted workspace if backend rollback also fails', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'plan-v1' });
    mocks.chooseFolder.mockResolvedValue('/broken');
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => path === '/broken'
      ? Promise.reject(new Error('broken list'))
      : defaultList?.(path));
    let startupComplete = false;
    mocks.setWorkspaceRoot.mockImplementation(async (path: string) => {
      if (path === '/workspace' && startupComplete) throw new Error('rollback denied');
      startupComplete = true;
      return path;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(await screen.findByText(/rollback denied/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /根目录新建/ })).toBeNull();
    expect(screen.getByText('No folder opened')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'plan.md' })).toBeNull();
  });

  it('serializes picker and Finder requests and commits only the latest target', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# file', version: 'v1' });
    mocks.chooseFolder.mockResolvedValue('/picker');
    mocks.findWorkspaceRoot.mockImplementation(async (path: string) => path.startsWith('/finder/') ? '/finder' : '/workspace');
    const pickerList = deferred<Array<{ name: string; path: string; kind: 'md' }>>();
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/picker') return pickerList.promise;
      if (path === '/finder') return Promise.resolve([{ name: 'docs', path: '/finder/docs', kind: 'folder' }]);
      if (path === '/finder/docs') return Promise.resolve([{ name: 'final.md', path: '/finder/docs/final.md', kind: 'md' }]);
      return defaultList?.(path);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.setWorkspaceRoot.mockClear();

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => expect(mocks.setWorkspaceRoot).toHaveBeenCalledWith('/picker'));
    await act(async () => mocks.openPathHandler?.('/finder/docs/final.md'));
    expect(mocks.setWorkspaceRoot).not.toHaveBeenCalledWith('/finder');
    await act(async () => pickerList.resolve([]));

    expect(await screen.findByText('finder / final.md')).toBeTruthy();
    expect(mocks.setWorkspaceRoot.mock.calls.map(([path]) => path)).toEqual(['/picker', '/finder']);
    expect(screen.queryByText('picker / LocalView')).toBeNull();
  });

  it('rolls A -> B -> C latest failure back to the original committed A root', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    mocks.findWorkspaceRoot.mockImplementation(async (path: string) => path.startsWith('/b/') ? '/b' : path.startsWith('/c/') ? '/c' : '/workspace');
    const bList = deferred<Array<{ name: string; path: string; kind: 'md' }>>();
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/b') return bList.promise;
      if (path === '/c') return Promise.reject(new Error('C failed'));
      return defaultList?.(path);
    });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.setWorkspaceRoot.mockClear();

    await act(async () => mocks.openPathHandler?.('/b/one.md'));
    await waitFor(() => expect(mocks.setWorkspaceRoot).toHaveBeenCalledWith('/b'));
    await act(async () => mocks.openPathHandler?.('/c/two.md'));
    await act(async () => bList.resolve([]));

    expect(await screen.findByText('C failed')).toBeTruthy();
    expect(mocks.setWorkspaceRoot.mock.calls.map(([path]) => path)).toEqual(['/b', '/c', '/workspace']);
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
  });

  it('waits for an in-flight save to finish before changing the backend root', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    mocks.chooseFolder.mockResolvedValue('/other');
    const save = deferred<string>();
    mocks.writeTextFile.mockImplementationOnce(() => save.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# saving');
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledOnce());
    mocks.setWorkspaceRoot.mockClear();

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(mocks.setWorkspaceRoot).not.toHaveBeenCalledWith('/other');
    expect(screen.getByRole('button', { name: '打开文件夹' })).toHaveProperty('disabled', true);

    await act(async () => save.resolve('v2'));
    await screen.findByRole('button', { name: '在 OTHER 根目录新建' });
    expect(mocks.setWorkspaceRoot).toHaveBeenCalledWith('/other');
  });

  it('lets an already-open picker supersede a Finder transition without concurrent roots', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# file', version: 'v1' });
    const picker = deferred<string | null>();
    mocks.chooseFolder.mockImplementationOnce(() => picker.promise);
    mocks.findWorkspaceRoot.mockImplementation(async (path: string) => path.startsWith('/finder/') ? '/finder' : '/workspace');
    const finderList = deferred<Array<{ name: string; path: string; kind: 'md' }>>();
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/finder') return finderList.promise;
      if (path === '/picker') return Promise.resolve([]);
      return defaultList?.(path);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.setWorkspaceRoot.mockClear();

    void user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => expect(mocks.chooseFolder).toHaveBeenCalledOnce());
    await act(async () => mocks.openPathHandler?.('/finder/first.md'));
    await waitFor(() => expect(mocks.setWorkspaceRoot).toHaveBeenCalledWith('/finder'));
    await act(async () => picker.resolve('/picker'));
    await waitFor(() => expect(mocks.inspectPath).toHaveBeenCalledWith('/picker'));
    await act(async () => finderList.resolve([]));

    expect(await screen.findByRole('button', { name: '在 PICKER 根目录新建' })).toBeTruthy();
    expect(mocks.setWorkspaceRoot.mock.calls.map(([path]) => path)).toEqual(['/finder', '/picker']);
  });
});

describe('stale document reads', () => {
  it('keeps navigation locked until a deferred file load settles', async () => {
    mocks.desktop = true;
    mocks.chooseFolder.mockResolvedValue('/other');
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/workspace/docs') return Promise.resolve([
        { name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' },
        { name: 'second.md', path: '/workspace/docs/second.md', kind: 'md' },
      ]);
      return defaultList?.(path);
    });
    mocks.readTextFile.mockResolvedValueOnce({ content: '# plan', version: 'v1' });
    const staleRead = deferred<{ content: string; version: string }>();
    mocks.readTextFile.mockImplementationOnce(() => staleRead.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await user.click(screen.getByRole('button', { name: 'second.md' }));
    await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledWith('/workspace/docs/second.md'));
    expect(screen.getByRole('button', { name: '打开文件夹' })).toHaveProperty('disabled', true);
    await act(async () => staleRead.resolve({ content: '# second', version: 'v2' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '打开文件夹' })).toHaveProperty('disabled', false));
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await screen.findByRole('button', { name: '在 OTHER 根目录新建' });

    expect(screen.getByText('other / LocalView')).toBeTruthy();
    expect(screen.queryByText('读取中…')).toBeNull();
  });

  it('silences a deferred external poll snapshot after workspace commit', async () => {
    mocks.desktop = true;
    mocks.chooseFolder.mockResolvedValue('/other');
    mocks.readTextFile.mockResolvedValueOnce({ content: '# plan', version: 'v1' });
    const pollRead = deferred<{ content: string; version: string }>();
    mocks.readTextFile.mockImplementationOnce(() => pollRead.promise);
    let poll: (() => Promise<void>) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (timeout === 5000) poll = handler as () => Promise<void>;
      return 1;
    }) as typeof window.setInterval);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await act(async () => { void poll?.(); });
    await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await screen.findByRole('button', { name: '在 OTHER 根目录新建' });
    await act(async () => pollRead.resolve({ content: '# stale poll', version: 'v2' }));

    expect(screen.getByText('other / LocalView')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'stale poll' })).toBeNull();
    expect(screen.queryByText(/无法读取磁盘文件/)).toBeNull();
  });

  it('silences a confirmed conflict reload that resolves after workspace commit', async () => {
    mocks.desktop = true;
    mocks.chooseFolder.mockResolvedValue('/other');
    mocks.readTextFile.mockResolvedValueOnce({ content: '# disk v1', version: 'v1' });
    const conflictReload = deferred<{ content: string; version: string }>();
    mocks.readTextFile.mockImplementationOnce(() => conflictReload.promise);
    mocks.writeTextFile.mockRejectedValueOnce(new Error('EXTERNAL_CHANGE: changed outside'));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# local edits');
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await user.click(await screen.findByRole('button', { name: '重新载入磁盘版本' }));
    await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await user.click(await screen.findByRole('button', { name: '放弃修改并切换文件夹' }));
    await screen.findByRole('button', { name: '在 OTHER 根目录新建' });
    await act(async () => conflictReload.resolve({ content: '# stale conflict', version: 'v3' }));

    expect(screen.getByText('other / LocalView')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'stale conflict' })).toBeNull();
    expect(screen.queryByText('已重新载入磁盘版本')).toBeNull();
  });
});

describe('Markdown create failure classification', () => {
  it.each([
    ['MARKDOWN_PARENT_NOT_DIRECTORY', '目标不是可写文件夹'],
    ['MARKDOWN_PARENT_CHANGED', '目标文件夹已发生变化，请重试'],
    ['WORKSPACE_ROOT_CHANGED', '工作区目录已发生变化，请重新打开'],
    ['CREATE_MARKDOWN_UNSUPPORTED', '当前系统暂不支持安全新建 Markdown'],
    ['CREATE_MARKDOWN_FAILED: permission denied', 'CREATE_MARKDOWN_FAILED: permission denied'],
  ])('keeps stable backend failure %s definitive', async (code, expected) => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    mocks.createMarkdownFile.mockRejectedValueOnce(new Error(code));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.listDirectory.mockClear();

    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    await user.type(input, 'failed{Enter}');

    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(input).toHaveProperty('value', 'failed');
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });

  it('reconciles an ambiguous rejection without claiming or selecting the discovered file', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    mocks.createMarkdownFile.mockRejectedValueOnce(new Error('channel closed'));
    const defaultList = mocks.listDirectory.getMockImplementation();
    let reconcile = false;
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/workspace' && reconcile) {
        return Promise.resolve([
          { name: 'docs', path: '/workspace/docs', kind: 'folder' },
          { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
          { name: 'maybe.md', path: '/workspace/maybe.md', kind: 'md' },
        ]);
      }
      return defaultList?.(path);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    reconcile = true;

    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    await user.type(input, 'maybe{Enter}');

    expect(await screen.findByText(/创建结果不确定：channel closed；目录已刷新，请确认/)).toBeTruthy();
    const discovered = screen.getByRole('button', { name: 'maybe.md' });
    expect(discovered.getAttribute('aria-current')).toBeNull();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(input).toHaveProperty('value', 'maybe');
  });

  it('rejects an extension-overflow name locally without invoking desktop creation', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await beginMarkdownCreate(user, '在 WORKSPACE 根目录新建');
    const input = screen.getByRole('textbox', { name: '在 workspace 中新建 Markdown 文件' });
    fireEvent.change(input, { target: { value: 'a'.repeat(253) } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('文件名过长，请缩短后重试')).toBeTruthy();
    expect(mocks.createMarkdownFile).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Finder incoming Office files', () => {
  it('expands the parent, selects the file, and keeps it outside edit/save flow', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 250,
      y: 88,
      left: 250,
      top: 88,
      width: 900,
      height: 680,
      right: 1150,
      bottom: 768,
      toJSON: () => ({}),
    } as DOMRect);
    render(<App />);

    await screen.findByText('workspace / plan.md');
    await act(async () => mocks.openPathHandler?.('/workspace/docs/report.pages'));

    expect(await screen.findByText('workspace / report.pages')).toBeTruthy();
    expect(screen.getByRole('button', { name: /report\.pages$/ }).className).toContain('active');
    expect(await screen.findByRole('region', { name: 'report.pages 内嵌系统预览' })).toBeTruthy();
    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledWith(
      '/workspace/docs/report.pages',
      { x: 250, y: 88, width: 900, height: 680 },
      expect.any(Number),
    ));
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '分栏' })).toBeNull();

    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await Promise.resolve();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(screen.getByText('只读 · Quick Look 交互预览')).toBeTruthy();
  });
});

describe('workspace entry rename', () => {
  it('starts inline rename by double-clicking only the tree name', async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = screen.getByRole('button', { name: 'README.md' });
    const name = row.querySelector('.tree-name');
    expect(name).toBeTruthy();
    await user.dblClick(name!);

    expect(screen.getByRole('textbox', { name: '重命名 README.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑当前文件名称' })).toBeTruthy();
  });

  it('waits for an unselected file navigation before starting double-click rename', async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = screen.getByRole('button', { name: 'product-notes.md' });
    await user.dblClick(row.querySelector('.tree-name')!);

    expect(await screen.findByRole('textbox', { name: '重命名 product-notes.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑当前文件名称' }).textContent)
      .toBe('product-notes.md');
  });

  it('renames in the document title and submits when clicking outside', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.dblClick(screen.getByRole('button', { name: '编辑当前文件名称' }));
    const input = screen.getByRole('textbox', { name: '重命名 README.md' });
    await user.clear(input);
    await user.type(input, 'HOME');
    await user.click(await screen.findByRole('heading', { name: 'Local Folder Viewer' }));

    expect(await screen.findByRole('button', { name: 'HOME.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑当前文件名称' }).textContent).toBe('HOME.md');
  });

  it('silently exits an unchanged title rename on blur', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.dblClick(screen.getByRole('button', { name: '编辑当前文件名称' }));
    await user.click(await screen.findByRole('heading', { name: 'Local Folder Viewer' }));

    await waitFor(() => expect(screen.queryByRole('textbox', { name: '重命名 README.md' })).toBeNull());
    expect(screen.getByRole('button', { name: '编辑当前文件名称' }).textContent).toBe('README.md');
    expect(screen.queryByText(/已模拟重命名/)).toBeNull();
  });

  it('keeps and refocuses an invalid title rename after blur', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.dblClick(screen.getByRole('button', { name: '编辑当前文件名称' }));
    const input = screen.getByRole('textbox', { name: '重命名 README.md' });
    await user.clear(input);
    await user.type(input, 'bad/name');
    await user.click(await screen.findByRole('heading', { name: 'Local Folder Viewer' }));

    expect(await screen.findByText('请输入有效名称')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('continues a different tree click after a blur rename succeeds', async () => {
    const user = userEvent.setup();
    render(<App />);

    const sourceRow = screen.getByRole('button', { name: 'README.md' });
    await user.dblClick(sourceRow.querySelector('.tree-name')!);
    const input = screen.getByRole('textbox', { name: '重命名 README.md' });
    await user.clear(input);
    await user.type(input, 'HOME');
    const docs = screen.getByRole('button', { name: 'docs' });
    expect(docs.getAttribute('aria-expanded')).toBe('true');
    await user.click(docs);

    expect(await screen.findByRole('button', { name: 'HOME.md' })).toBeTruthy();
    await waitFor(() => expect(docs.getAttribute('aria-expanded')).toBe('false'));
  });

  it('renames the browser demo inline while preserving the locked suffix and content', async () => {
    const user = userEvent.setup();
    render(<App />);

    await beginEntryRename(user, 'README.md 操作');
    const input = screen.getByRole('textbox', { name: '重命名 README.md' });
    expect((input as HTMLInputElement).value).toBe('README');
    await user.clear(input);
    await user.type(input, 'HOME{Enter}');

    expect(await screen.findByRole('button', { name: 'HOME.md' })).toBeTruthy();
    expect(screen.getByText('project / HOME.md')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Local Folder Viewer' })).toBeTruthy();
  });

  it('flushes a selected dirty document before rename and retargets Finder reveal', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const listBeforeRename = mocks.listDirectory.getMockImplementation()!;
    mocks.listDirectory.mockImplementation(async (path: string) => {
      const entries = await listBeforeRename(path);
      // A delayed directory refresh must observe the same rename as the command result.
      return mocks.renameWorkspaceEntry.mock.calls.length ? entries.map((entry: { path: string }) => (
        entry.path === '/workspace/docs/plan.md'
          ? { ...entry, name: 'strategy.md', path: '/workspace/docs/strategy.md' }
          : entry
      )) : entries;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# local rename draft');

    await beginEntryRename(user, 'plan.md 操作');
    const input = screen.getByRole('textbox', { name: '重命名 plan.md' });
    await user.clear(input);
    await user.type(input, 'strategy{Enter}');

    await waitFor(() => expect(mocks.renameWorkspaceEntry).toHaveBeenCalledOnce());
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      '/workspace/docs/plan.md',
      '# local rename draft',
      'v1',
    );
    expect(mocks.prepareWorkspaceRename).toHaveBeenCalledWith(
      '/workspace/docs/plan.md',
      'strategy.md',
    );
    expect(await screen.findByRole('button', { name: 'strategy.md' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '在 Finder 中显示' }));
    expect(mocks.revealPath).toHaveBeenCalledWith('/workspace/docs/strategy.md');
  });

  it('does not force-save an unrelated dirty document', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# unrelated dirty draft');
    mocks.writeTextFile.mockClear();

    await beginEntryRename(user, 'report.pages 操作');
    const input = screen.getByRole('textbox', { name: '重命名 report.pages' });
    await user.clear(input);
    await user.type(input, 'summary{Enter}');

    await waitFor(() => expect(mocks.renameWorkspaceEntry).toHaveBeenCalledOnce());
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'editor' }) as HTMLTextAreaElement).value)
      .toBe('# unrelated dirty draft');
  });

  it('keeps the inline editor on a definitive failure and never applies a false success', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.renameWorkspaceEntry.mockRejectedValue({
      code: 'RENAME_DESTINATION_EXISTS',
      message: 'collision',
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginEntryRename(user, 'plan.md 操作');
    const input = screen.getByRole('textbox', { name: '重命名 plan.md' });
    await user.clear(input);
    await user.type(input, 'taken{Enter}');

    expect(await screen.findByText('当前文件夹中已存在同名项目')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '重命名 plan.md' }).getAttribute('aria-invalid'))
      .toBe('true');
    expect(screen.queryByRole('button', { name: 'taken.md' })).toBeNull();
  });

  it('treats typed uncertain as refresh-only even if reconciliation sees destination', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.renameWorkspaceEntry.mockRejectedValue({
      code: 'RENAME_OUTCOME_UNCERTAIN',
      message: 'uncertain',
    });
    mocks.reconcileWorkspaceRename.mockResolvedValue({
      outcome: 'destination',
      entry: { name: 'maybe.md', path: '/workspace/docs/maybe.md', kind: 'md' },
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');

    await beginEntryRename(user, 'plan.md 操作');
    const input = screen.getByRole('textbox', { name: '重命名 plan.md' });
    await user.clear(input);
    await user.type(input, 'maybe{Enter}');

    expect(await screen.findByText(/重命名结果不确定/)).toBeTruthy();
    expect(mocks.reconcileWorkspaceRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: '重命名 plan.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'maybe.md' })).toBeNull();
  });

  it('renames an ancestor folder after saving and migrates the selected descendant path', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# folder rename draft');

    await beginEntryRename(user, 'docs 文件夹操作');
    const input = screen.getByRole('textbox', { name: '重命名 docs' });
    await user.clear(input);
    await user.type(input, 'knowledge{Enter}');

    expect(await screen.findByRole('button', { name: 'knowledge' })).toBeTruthy();
    expect(screen.getByText('/workspace/knowledge/plan.md')).toBeTruthy();
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      '/workspace/docs/plan.md',
      '# folder rename draft',
      'v1',
    );
  });

  it('releases the old HTML capability and prepares the renamed path', async () => {
    mocks.desktop = true;
    let renamed = false;
    mocks.getWindowBootstrap.mockResolvedValue({
      initialPath: '/workspace/docs/index.html',
      sessionId: 'testprocess.0',
      restoreMode: 'none',
    });
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === '/workspace') return [{ name: 'docs', path: '/workspace/docs', kind: 'folder' }];
      if (path === '/workspace/docs') return [{
        name: renamed ? 'home.html' : 'index.html',
        path: renamed ? '/workspace/docs/home.html' : '/workspace/docs/index.html',
        kind: 'html',
      }];
      return [];
    });
    mocks.renameWorkspaceEntry.mockImplementationOnce(async (candidate: {
      sourcePath: string;
      destinationPath: string;
    }) => {
      renamed = true;
      return {
        originalPath: candidate.sourcePath,
        renamedPath: candidate.destinationPath,
        entry: { name: 'home.html', path: candidate.destinationPath, kind: 'html' },
      };
    });
    mocks.readTextFile.mockResolvedValue({ content: '<h1>hello</h1>', version: 'html-v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / index.html');
    await waitFor(() => expect(mocks.prepareHtmlPreview).toHaveBeenCalledWith(
      '/workspace/docs/index.html',
    ));

    await beginEntryRename(user, 'index.html 操作');
    const input = screen.getByRole('textbox', { name: '重命名 index.html' });
    await user.clear(input);
    await user.type(input, 'home{Enter}');

    await waitFor(() => expect(mocks.prepareHtmlPreview).toHaveBeenCalledWith(
      '/workspace/docs/home.html',
    ));
    expect(mocks.releaseHtmlPreview).toHaveBeenCalledWith('preview-token');
  });

  it('restarts embedded Quick Look for a renamed selected document', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 250, y: 88, left: 250, top: 88, width: 900, height: 680,
      right: 1150, bottom: 768, toJSON: () => ({}),
    } as DOMRect);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await user.click(screen.getByRole('button', { name: 'report.pages' }));
    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledWith(
      '/workspace/docs/report.pages',
      expect.any(Object),
      expect.any(Number),
    ));

    await beginEntryRename(user, 'report.pages 操作');
    const input = screen.getByRole('textbox', { name: '重命名 report.pages' });
    await user.clear(input);
    await user.type(input, 'summary{Enter}');

    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledWith(
      '/workspace/docs/summary.pages',
      expect.any(Object),
      expect.any(Number),
    ));
    expect(mocks.hideEmbeddedQuickLook).toHaveBeenCalled();
  });

  it('reloads Spreadsheet data from the renamed selected path', async () => {
    mocks.desktop = true;
    mocks.getWindowBootstrap.mockResolvedValue({
      initialPath: '/workspace/docs/budget.xlsx',
      sessionId: 'testprocess.0',
      restoreMode: 'none',
    });
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === '/workspace') return [{ name: 'docs', path: '/workspace/docs', kind: 'folder' }];
      if (path === '/workspace/docs') return [{
        name: 'budget.xlsx', path: '/workspace/docs/budget.xlsx', kind: 'spreadsheet',
      }];
      return [];
    });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mocks.readSpreadsheet).toHaveBeenCalledWith(
      '/workspace/docs/budget.xlsx',
    ));

    await beginEntryRename(user, 'budget.xlsx 操作');
    const input = screen.getByRole('textbox', { name: '重命名 budget.xlsx' });
    await user.clear(input);
    await user.type(input, 'forecast{Enter}');

    await waitFor(() => expect(mocks.readSpreadsheet).toHaveBeenCalledWith(
      '/workspace/docs/forecast.xlsx',
    ));
  });

  it('coalesces a self watcher rename that arrives before the command response', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({
      path: '/workspace', generation: 1, watching: true, assetScope: 'scope-1',
    });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const defaultList = mocks.listDirectory.getMockImplementation();
    let committed = false;
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (committed && path === '/workspace/docs') return [
        { name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' },
        { name: 'summary.pages', path: '/workspace/docs/summary.pages', kind: 'document' },
      ];
      return defaultList?.(path);
    });
    const commit = deferred<any>();
    mocks.renameWorkspaceEntry.mockReturnValueOnce(commit.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await beginEntryRename(user, 'report.pages 操作');
    const input = screen.getByRole('textbox', { name: '重命名 report.pages' });
    await user.clear(input);
    await user.type(input, 'summary{Enter}');
    await waitFor(() => expect(mocks.renameWorkspaceEntry).toHaveBeenCalledOnce());

    act(() => mocks.workspaceChangeHandler?.({
      rootPath: '/workspace',
      generation: 1,
      events: [{
        kind: 'rename',
        paths: ['/workspace/docs/report.pages', '/workspace/docs/summary.pages'],
      }],
    }));
    committed = true;
    await act(async () => commit.resolve({
      originalPath: '/workspace/docs/report.pages',
      renamedPath: '/workspace/docs/summary.pages',
      entry: { name: 'summary.pages', path: '/workspace/docs/summary.pages', kind: 'document' },
    }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'summary.pages' })).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'summary.pages' })).toHaveLength(1);
  });

  it('bounds rename watcher buffering and rescans after the 33rd related batch', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({
      path: '/workspace', generation: 1, watching: true, assetScope: 'scope-1',
    });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const defaultList = mocks.listDirectory.getMockImplementation();
    let committed = false;
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (committed && path === '/workspace/docs') return [
        { name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' },
        { name: 'summary.pages', path: '/workspace/docs/summary.pages', kind: 'document' },
      ];
      return defaultList?.(path);
    });
    const commit = deferred<any>();
    mocks.renameWorkspaceEntry.mockReturnValueOnce(commit.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.listDirectory.mockClear();
    await beginEntryRename(user, 'report.pages 操作');
    const input = screen.getByRole('textbox', { name: '重命名 report.pages' });
    await user.clear(input);
    await user.type(input, 'summary{Enter}');
    await waitFor(() => expect(mocks.renameWorkspaceEntry).toHaveBeenCalledOnce());

    act(() => {
      for (let index = 0; index < 33; index += 1) {
        mocks.workspaceChangeHandler?.({
          rootPath: '/workspace',
          generation: 1,
          events: [{ kind: 'modify', paths: ['/workspace/docs/report.pages'] }],
        });
      }
    });
    expect(mocks.listDirectory).not.toHaveBeenCalled();

    committed = true;
    await act(async () => commit.resolve({
      originalPath: '/workspace/docs/report.pages',
      renamedPath: '/workspace/docs/summary.pages',
      entry: { name: 'summary.pages', path: '/workspace/docs/summary.pages', kind: 'document' },
    }));
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalled());
    expect(mocks.listDirectory.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('waits for an in-flight rename before closing the window', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const pendingRename = deferred<Awaited<ReturnType<typeof mocks.renameWorkspaceEntry>>>();
    mocks.renameWorkspaceEntry.mockReturnValueOnce(pendingRename.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await beginEntryRename(user, 'plan.md 操作');
    const input = screen.getByRole('textbox', { name: '重命名 plan.md' });
    await user.clear(input);
    await user.type(input, 'after-close{Enter}');
    await waitFor(() => expect(mocks.renameWorkspaceEntry).toHaveBeenCalledOnce());

    const preventDefault = vi.fn();
    await act(async () => mocks.closeHandler?.({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.destroyWindow).not.toHaveBeenCalled();
    expect(mocks.closeWindow).not.toHaveBeenCalled();

    await act(async () => pendingRename.resolve({
      originalPath: '/workspace/docs/plan.md',
      renamedPath: '/workspace/docs/after-close.md',
      entry: { name: 'after-close.md', path: '/workspace/docs/after-close.md', kind: 'md' },
    }));
    await waitFor(() => expect(mocks.destroyWindow).toHaveBeenCalledOnce());
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it('waits for an in-flight rename before a Finder workspace transition', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const pendingRename = deferred<any>();
    mocks.renameWorkspaceEntry.mockReturnValueOnce(pendingRename.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await beginEntryRename(user, 'plan.md 操作');
    const input = screen.getByRole('textbox', { name: '重命名 plan.md' });
    await user.clear(input);
    await user.type(input, 'before-transition{Enter}');
    await waitFor(() => expect(mocks.renameWorkspaceEntry).toHaveBeenCalledOnce());
    const listCallsBeforeTransition = mocks.listDirectory.mock.calls.length;

    act(() => mocks.openPathHandler?.('/workspace/docs/report.pages'));
    await Promise.resolve();
    expect(mocks.listDirectory.mock.calls.length).toBe(listCallsBeforeTransition);

    await act(async () => pendingRename.resolve({
      originalPath: '/workspace/docs/plan.md',
      renamedPath: '/workspace/docs/before-transition.md',
      entry: {
        name: 'before-transition.md',
        path: '/workspace/docs/before-transition.md',
        kind: 'md',
      },
    }));
    expect(await screen.findByText('workspace / report.pages')).toBeTruthy();
  });

  it('waits for an in-flight rename before answering application quit', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const pendingRename = deferred<any>();
    mocks.renameWorkspaceEntry.mockReturnValueOnce(pendingRename.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await beginEntryRename(user, 'plan.md 操作');
    const input = screen.getByRole('textbox', { name: '重命名 plan.md' });
    await user.clear(input);
    await user.type(input, 'before-quit{Enter}');
    await waitFor(() => expect(mocks.renameWorkspaceEntry).toHaveBeenCalledOnce());

    act(() => mocks.quitRequestHandler?.({ generation: 91 }));
    await Promise.resolve();
    expect(mocks.respondAppQuit).not.toHaveBeenCalled();

    await act(async () => pendingRename.resolve({
      originalPath: '/workspace/docs/plan.md',
      renamedPath: '/workspace/docs/before-quit.md',
      entry: { name: 'before-quit.md', path: '/workspace/docs/before-quit.md', kind: 'md' },
    }));
    await waitFor(() => expect(mocks.respondAppQuit).toHaveBeenCalledWith(91, 'saved'));
  });
});

describe('workspace file moves', () => {
  it('activates the first folder target before a move-source prop update when WKWebView hides transfer types', () => {
    const onMoveStart = vi.fn(() => true);
    const onMoveTarget = vi.fn(() => true);
    const onMoveDrop = vi.fn();
    render(<FileTree
      tree={[
        { name: 'source.md', path: '/workspace/source.md', kind: 'md' },
        { name: 'target', path: '/workspace/target', kind: 'folder' },
      ]}
      rootPath="/workspace"
      openFolders={new Set()}
      selectedPath={null}
      locked={false}
      createDraft={null}
      createBusy={false}
      createInvalid={false}
      preparingFolders={new Set()}
      createInputRef={createRef()}
      renameDraft={null}
      renameBusy={false}
      renameInvalid={false}
      renameInputRef={createRef()}
      focusPath={null}
      moveSourcePath={null}
      moveTargetPath={null}
      moveTargetAllowed={false}
      moveDragId={1}
      onFocusHandled={vi.fn()}
      onNodeClick={vi.fn()}
      onNodeContextMenu={vi.fn()}
      onOpenCreateMenu={vi.fn()}
      onOpenNodeMenu={vi.fn()}
      onSubmitCreate={vi.fn()}
      onCancelCreate={vi.fn()}
      onBeginRename={vi.fn()}
      onSubmitRename={vi.fn()}
      onCancelRename={vi.fn()}
      onMoveStart={onMoveStart}
      onMoveTarget={onMoveTarget}
      onMoveHoverExpand={vi.fn()}
      onMoveDrop={onMoveDrop}
      onMoveEnd={vi.fn()}
    />);
    const sourceTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types: [] as string[],
      setData: vi.fn(),
    };
    fireEvent.dragStart(screen.getByRole('button', { name: 'source.md' }), {
      dataTransfer: sourceTransfer,
    });
    expect(onMoveStart).toHaveBeenCalledOnce();

    const target = screen.getByRole('button', { name: 'target' });
    const targetRow = target.closest('.tree-row') as HTMLDivElement;
    const protectedTargetTransfer = {
      effectAllowed: 'move',
      dropEffect: 'none',
      types: [] as string[],
      setData: vi.fn(),
    };
    fireEvent.dragEnter(targetRow, { dataTransfer: protectedTargetTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer: protectedTargetTransfer });
    expect(onMoveTarget).toHaveBeenCalledWith('/workspace/target');
    expect(protectedTargetTransfer.dropEffect).toBe('move');
    fireEvent.drop(targetRow, { dataTransfer: protectedTargetTransfer });
    expect(onMoveDrop).toHaveBeenCalledWith('/workspace/target');

    onMoveStart.mockReturnValue(false);
    onMoveTarget.mockClear();
    onMoveDrop.mockClear();
    const rejectedTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types: [] as string[],
      setData: vi.fn(),
    };
    expect(fireEvent.dragStart(screen.getByRole('button', { name: 'source.md' }), {
      dataTransfer: rejectedTransfer,
    })).toBe(false);
    expect(rejectedTransfer.setData).not.toHaveBeenCalled();
    fireEvent.dragEnter(targetRow, { dataTransfer: protectedTargetTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer: protectedTargetTransfer });
    fireEvent.drop(targetRow, { dataTransfer: protectedTargetTransfer });
    expect(onMoveTarget).not.toHaveBeenCalled();
    expect(onMoveDrop).not.toHaveBeenCalled();
  });

  it('clears the synchronous folder-target handshake on Escape', () => {
    render(<App />);
    const source = screen.getByRole('button', { name: 'README.md' });
    const sourceRow = source.closest('.tree-row') as HTMLDivElement;
    const sourceTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types: [] as string[],
      setData: vi.fn(),
    };
    fireEvent.dragStart(source, { dataTransfer: sourceTransfer });
    expect(sourceRow.className).toContain('move-source');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sourceRow.className).not.toContain('move-source');
    const destination = screen.getByRole('button', { name: 'docs' });
    const destinationRow = destination.closest('.tree-row') as HTMLDivElement;
    const protectedTargetTransfer = {
      effectAllowed: 'move',
      dropEffect: 'none',
      types: [] as string[],
      setData: vi.fn(),
    };
    fireEvent.dragEnter(destinationRow, { dataTransfer: protectedTargetTransfer });
    fireEvent.dragOver(destinationRow, { dataTransfer: protectedTargetTransfer });
    expect(destinationRow.className).not.toContain('move-target-valid');
  });

  it('uses the exact non-native tree main as the draggable source', () => {
    render(<App />);
    const source = screen.getByRole('button', { name: 'README.md' });
    const sourceRow = source.closest('.tree-row') as HTMLDivElement;

    expect(source.tagName).toBe('DIV');
    expect(source.className).toContain('tree-row-main');
    expect(source.getAttribute('draggable')).toBe('true');
    expect(sourceRow.getAttribute('draggable')).toBeNull();

    const folder = screen.getByRole('button', { name: 'docs' });
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(folder, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'docs' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(screen.getByRole('button', { name: 'docs' }), { key: ' ' });
    expect(screen.getByRole('button', { name: 'docs' }).getAttribute('aria-expanded')).toBe('true');

    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types: [] as string[],
      setData: vi.fn(),
    };
    fireEvent.dragStart(screen.getByRole('button', { name: '在 docs 中新建' }), { dataTransfer });
    fireEvent.dragStart(screen.getByRole('button', { name: 'docs 文件夹操作' }), { dataTransfer });
    expect(dataTransfer.setData).not.toHaveBeenCalled();
  });

  it('moves a browser-demo file by drag and drop without desktop IPC', async () => {
    render(<App />);
    const source = screen.getByRole('button', { name: 'README.md' });
    const destination = screen.getByRole('button', { name: 'docs' });
    const destinationRow = destination.closest('.tree-row') as HTMLDivElement;
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types,
      setData: vi.fn((type: string) => {
        if (!types.includes(type)) types.push(type);
      }),
    };

    fireEvent.dragStart(source, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(LOCALVIEW_TREE_DRAG_TYPE, '/Users/thera/project/README.md');
    fireEvent.dragEnter(destinationRow, { dataTransfer });
    fireEvent.dragOver(destinationRow, { dataTransfer });
    expect(destinationRow.className).toContain('move-target-valid');
    fireEvent.dragLeave(destinationRow, { dataTransfer, relatedTarget: document.body });
    expect(destinationRow.className).not.toContain('move-target-valid');
    fireEvent.dragEnter(destinationRow, { dataTransfer });
    fireEvent.dragOver(destinationRow, { dataTransfer });
    fireEvent.drop(destinationRow, { dataTransfer });

    await waitFor(() => expect(screen.getByRole('button', { name: 'README.md' }).dataset.treePath)
      .toBe('/Users/thera/project/docs/README.md'));
    expect(screen.getByText('project / README.md')).toBeTruthy();
    expect(await screen.findByText(/浏览器 Demo 已模拟移动 README\.md/)).toBeTruthy();
    expect(mocks.prepareWorkspaceMove).not.toHaveBeenCalled();
    expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();
  });

  it('moves a nested browser-demo file to the workspace root on the first drag', async () => {
    render(<App />);
    const source = screen.getByRole('button', { name: 'product-notes.md' });
    const rootTarget = screen.getByText('PROJECT').closest('.sidebar-header') as HTMLDivElement;
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types,
      setData: vi.fn((type: string) => {
        if (!types.includes(type)) types.push(type);
      }),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragEnter(rootTarget, { dataTransfer });
    expect(rootTarget.className).toContain('move-target-valid');
    const childLeave = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.defineProperty(childLeave, 'dataTransfer', { value: dataTransfer });
    Object.defineProperty(childLeave, 'relatedTarget', {
      value: screen.getByRole('button', { name: '在 PROJECT 根目录新建' }),
    });
    fireEvent(screen.getByText('PROJECT'), childLeave);
    expect(rootTarget.className).toContain('move-target-valid');
    fireEvent.dragOver(rootTarget, { dataTransfer });
    fireEvent.drop(rootTarget, { dataTransfer });

    await waitFor(() => expect(screen.getByRole('button', { name: 'product-notes.md' }).dataset.treePath)
      .toBe('/Users/thera/project/product-notes.md'));
    expect(await screen.findByText(/浏览器 Demo 已模拟移动 product-notes\.md/)).toBeTruthy();
  });

  it('moves a loaded folder into another folder and back to the workspace root', async () => {
    render(<App />);
    const docs = screen.getByRole('button', { name: 'docs' });
    const prototypeRow = screen.getByRole('button', { name: 'prototype' }).closest('.tree-row') as HTMLDivElement;
    const firstTypes: string[] = [];
    const firstTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types: firstTypes,
      setData: vi.fn((type: string) => {
        if (!firstTypes.includes(type)) firstTypes.push(type);
      }),
    };

    fireEvent.dragStart(docs, { dataTransfer: firstTransfer });
    fireEvent.dragEnter(prototypeRow, { dataTransfer: firstTransfer });
    fireEvent.dragOver(prototypeRow, { dataTransfer: firstTransfer });
    expect(prototypeRow.className).toContain('move-target-valid');
    fireEvent.drop(prototypeRow, { dataTransfer: firstTransfer });

    await waitFor(() => expect(screen.getByRole('button', { name: 'docs' }).dataset.treePath)
      .toBe('/Users/thera/project/prototype/docs'));
    expect(screen.getByRole('button', { name: 'product-notes.md' }).dataset.treePath)
      .toBe('/Users/thera/project/prototype/docs/product-notes.md');

    const movedDocs = screen.getByRole('button', { name: 'docs' });
    const rootTarget = screen.getByText('PROJECT').closest('.sidebar-header') as HTMLDivElement;
    const secondTypes: string[] = [];
    const secondTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types: secondTypes,
      setData: vi.fn((type: string) => {
        if (!secondTypes.includes(type)) secondTypes.push(type);
      }),
    };
    fireEvent.dragStart(movedDocs, { dataTransfer: secondTransfer });
    fireEvent.dragEnter(rootTarget, { dataTransfer: secondTransfer });
    fireEvent.dragOver(rootTarget, { dataTransfer: secondTransfer });
    fireEvent.drop(rootTarget, { dataTransfer: secondTransfer });

    await waitFor(() => expect(screen.getByRole('button', { name: 'docs' }).dataset.treePath)
      .toBe('/Users/thera/project/docs'));
    expect(screen.getByRole('button', { name: 'product-notes.md' }).dataset.treePath)
      .toBe('/Users/thera/project/docs/product-notes.md');
  });

  it('marks a folder drop onto itself invalid and leaves the tree unchanged', () => {
    render(<App />);
    const docs = screen.getByRole('button', { name: 'docs' });
    const docsRow = docs.closest('.tree-row') as HTMLDivElement;
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types,
      setData: (type: string) => {
        if (!types.includes(type)) types.push(type);
      },
    };

    fireEvent.dragStart(docs, { dataTransfer });
    fireEvent.dragEnter(docsRow, { dataTransfer });
    fireEvent.dragOver(docsRow, { dataTransfer });
    expect(docsRow.className).toContain('move-target-invalid');
    fireEvent.drop(docsRow, { dataTransfer });
    expect(screen.getByRole('button', { name: 'docs' }).dataset.treePath)
      .toBe('/Users/thera/project/docs');
  });

  it('blocks drag and the native picker while an inline create draft is active', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await userEvent.click(screen.getByRole('button', { name: '在 WORKSPACE 根目录新建' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '新建 Markdown' }));
    expect(await screen.findByPlaceholderText('untitled.md')).toBeTruthy();

    const docs = screen.getByRole('button', { name: 'docs' });
    const docsRow = docs.closest('.tree-row') as HTMLDivElement;
    expect(docs.getAttribute('draggable')).toBe('false');
    expect(docsRow.getAttribute('draggable')).toBeNull();
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types: [] as string[],
      setData: vi.fn(),
    };
    fireEvent.dragStart(docs, { dataTransfer });
    expect(dataTransfer.setData).not.toHaveBeenCalled();

    fireEvent.contextMenu(docs, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));
    expect(await screen.findByText('请先完成或取消当前新建操作')).toBeTruthy();
    expect(mocks.chooseMoveDestination).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('untitled.md')).toBeTruthy();
  });

  it('opens a collapsed destination folder after a sustained tree hover', async () => {
    render(<App />);
    const source = screen.getByRole('button', { name: 'README.md' });
    const destination = screen.getByRole('button', { name: 'assets' });
    const destinationRow = destination.closest('.tree-row') as HTMLDivElement;
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types,
      setData: (type: string) => {
        if (!types.includes(type)) types.push(type);
      },
    };

    expect(destination.getAttribute('aria-expanded')).toBe('false');
    vi.useFakeTimers();
    try {
      fireEvent.dragStart(source, { dataTransfer });
      fireEvent.dragEnter(destinationRow, { dataTransfer });
      fireEvent.dragOver(destinationRow, { dataTransfer });
      expect(destinationRow.className).toContain('move-target-valid');
      await act(async () => vi.advanceTimersByTimeAsync(MOVE_HOVER_OPEN_DELAY_MS));
      expect(destination.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('button', { name: 'cover.png' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ghost-expand a folder after the drag leaves during async loading', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const targetLoad = deferred<Array<{ name: string; path: string; kind: 'md' }>>();
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === '/workspace') return [
        { name: 'docs', path: '/workspace/docs', kind: 'folder' },
        { name: 'target', path: '/workspace/target', kind: 'folder' },
      ];
      if (path === '/workspace/docs') return [
        { name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' },
      ];
      if (path === '/workspace/target') return targetLoad.promise;
      return [];
    });
    render(<App />);
    const source = await screen.findByRole('button', { name: 'plan.md' });
    const destination = screen.getByRole('button', { name: 'target' });
    const destinationRow = destination.closest('.tree-row') as HTMLDivElement;
    const types: string[] = [];
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      types,
      setData: (type: string) => {
        if (!types.includes(type)) types.push(type);
      },
    };

    vi.useFakeTimers();
    try {
      fireEvent.dragStart(source, { dataTransfer });
      fireEvent.dragEnter(destinationRow, { dataTransfer });
      await act(async () => vi.advanceTimersByTimeAsync(MOVE_HOVER_OPEN_DELAY_MS));
      expect(mocks.listDirectory).toHaveBeenCalledWith('/workspace/target');
      fireEvent.dragLeave(destinationRow, { dataTransfer, relatedTarget: document.body });
      await act(async () => targetLoad.resolve([
        { name: 'ghost.md', path: '/workspace/target/ghost.md', kind: 'md' },
      ]));
      await Promise.resolve();
      expect(screen.getByRole('button', { name: 'target' }).getAttribute('aria-expanded'))
        .toBe('false');
      expect(screen.queryByRole('button', { name: 'ghost.md' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('strictly saves and follows the currently selected dirty Markdown file', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (mocks.moveWorkspaceEntry.mock.calls.length && path === '/workspace/docs') return [
        { name: 'report.pages', path: '/workspace/docs/report.pages', kind: 'document' },
      ];
      if (mocks.moveWorkspaceEntry.mock.calls.length && path === '/workspace/drafts') return [
        { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
        { name: 'plan.md', path: '/workspace/drafts/plan.md', kind: 'md' },
      ];
      return defaultList?.(path);
    });
    render(<App />);
    const plan = await screen.findByRole('button', { name: 'plan.md' });
    await editCurrentDocument('# moved draft');

    fireEvent.contextMenu(plan, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledWith(
      '/workspace/docs/plan.md',
      '# moved draft',
      'v1',
    ));
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce());
    expect(mocks.chooseMoveDestination).toHaveBeenCalledWith('/workspace');
    expect(mocks.prepareWorkspaceMove).toHaveBeenCalledWith(
      '/workspace/docs/plan.md',
      '/workspace/drafts',
    );
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.getByText('/workspace/drafts/plan.md')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# moved draft');
  });

  it('moves a folder containing the selected dirty file and retargets the active document', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    const defaultList = mocks.listDirectory.getMockImplementation();
    let moved = false;
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (!moved) return defaultList?.(path);
      if (path === '/workspace') return [
        { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
      ];
      if (path === '/workspace/drafts') return [
        { name: 'docs', path: '/workspace/drafts/docs', kind: 'folder' },
        { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
      ];
      if (path === '/workspace/drafts/docs') return [
        { name: 'plan.md', path: '/workspace/drafts/docs/plan.md', kind: 'md' },
        { name: 'report.pages', path: '/workspace/drafts/docs/report.pages', kind: 'document' },
      ];
      return [];
    });
    mocks.moveWorkspaceEntry.mockImplementationOnce(async (candidate: {
      sourcePath: string;
      destinationPath: string;
    }) => {
      moved = true;
      return {
        originalPath: candidate.sourcePath,
        movedPath: candidate.destinationPath,
        entry: { name: 'docs', path: candidate.destinationPath, kind: 'folder' },
      };
    });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# moved with folder');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'docs' }), {
      clientX: 80,
      clientY: 100,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledWith(
      '/workspace/docs/plan.md',
      '# moved with folder',
      'v1',
    ));
    await waitFor(() => expect(mocks.prepareWorkspaceMove).toHaveBeenCalledWith(
      '/workspace/docs',
      '/workspace/drafts',
    ));
    await waitFor(() => expect(screen.getByRole('button', { name: 'plan.md' }).dataset.treePath)
      .toBe('/workspace/drafts/docs/plan.md'));
    expect(screen.getByText('/workspace/drafts/docs/plan.md')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'editor' }))
      .toHaveProperty('value', '# moved with folder');
  });

  it('keeps tree, selection, and save target unchanged when folder cycle validation fails', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    mocks.prepareWorkspaceMove.mockRejectedValueOnce({
      code: 'MOVE_DESTINATION_INSIDE_SOURCE',
      message: 'inside source',
    });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# before failed folder move');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'docs' }), {
      clientX: 80,
      clientY: 100,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    expect(await screen.findByText(/不能把文件夹移到它自己或子文件夹中/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'docs' }).dataset.treePath).toBe('/workspace/docs');
    expect(screen.getByRole('button', { name: 'plan.md' }).dataset.treePath)
      .toBe('/workspace/docs/plan.md');
    expect(screen.getByText('/workspace/docs/plan.md')).toBeTruthy();
    expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();

    await editCurrentDocument('# after failed folder move');
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenLastCalledWith(
      '/workspace/docs/plan.md',
      '# after failed folder move',
      'saved-version',
    ));
  });

  it('blocks a folder move when its selected dirty descendant cannot be saved', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.writeTextFile.mockRejectedValue({ code: 'EXTERNAL_CHANGE', message: 'changed outside' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# local descendant');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'docs' }), {
      clientX: 80,
      clientY: 100,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    expect(await screen.findByText(/无法移动当前项目：磁盘文件已经变化/)).toBeTruthy();
    expect(mocks.prepareWorkspaceMove).not.toHaveBeenCalled();
    expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'docs' }).dataset.treePath).toBe('/workspace/docs');
    expect(screen.getByRole('button', { name: 'plan.md' }).dataset.treePath)
      .toBe('/workspace/docs/plan.md');
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# local descendant');
  });

  it('blocks moving the current file on save conflict and keeps the original tree', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.writeTextFile.mockRejectedValue({ code: 'EXTERNAL_CHANGE', message: 'changed outside' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    render(<App />);
    const plan = await screen.findByRole('button', { name: 'plan.md' });
    await editCurrentDocument('# local');
    fireEvent.contextMenu(plan, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    expect(await screen.findByText(/无法移动当前项目：磁盘文件已经变化/)).toBeTruthy();
    expect(mocks.prepareWorkspaceMove).not.toHaveBeenCalled();
    expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'plan.md' }).dataset.treePath)
      .toBe('/workspace/docs/plan.md');
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# local');
  });

  it('moves an unrelated file without flushing the current draft', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# unsaved current');
    const report = screen.getByRole('button', { name: 'report.pages' });
    fireEvent.contextMenu(report, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce());
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# unsaved current');
  });

  it('reports an ambiguous IO result without guessing or removing the source', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    mocks.moveWorkspaceEntry.mockRejectedValueOnce({ code: 'IO_ERROR', message: 'response lost' });
    mocks.reconcileWorkspaceMove.mockResolvedValueOnce({ outcome: 'ambiguous' });
    render(<App />);
    const report = await screen.findByRole('button', { name: 'report.pages' });
    fireEvent.contextMenu(report, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    expect(await screen.findByText(/移动结果不确定/)).toBeTruthy();
    expect(mocks.reconcileWorkspaceMove).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'report.pages' }).dataset.treePath)
      .toBe('/workspace/docs/report.pages');
  });

  it('reconciles a typed uncertain move only for refresh and never claims success', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    mocks.moveWorkspaceEntry.mockRejectedValueOnce({
      code: 'MOVE_OUTCOME_UNCERTAIN',
      message: 'postcondition could not be proved',
    });
    mocks.reconcileWorkspaceMove.mockResolvedValueOnce({
      outcome: 'destination',
      entry: {
        name: 'report.pages',
        path: '/workspace/drafts/report.pages',
        kind: 'document',
      },
    });
    render(<App />);
    const report = await screen.findByRole('button', { name: 'report.pages' });
    fireEvent.contextMenu(report, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    expect(await screen.findByText(/移动结果不确定/)).toBeTruthy();
    expect(mocks.reconcileWorkspaceMove).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'report.pages' }).dataset.treePath)
      .toBe('/workspace/docs/report.pages');
    expect(screen.queryByText(/已将 report\.pages 移到/)).toBeNull();
  });

  it('rebuilds a selected descendant system renderer after its folder moves', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480,
      width: 640, height: 480, toJSON: () => ({}),
    } as DOMRect);
    const defaultList = mocks.listDirectory.getMockImplementation();
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (mocks.moveWorkspaceEntry.mock.calls.length && path === '/workspace') return [
        { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
      ];
      if (mocks.moveWorkspaceEntry.mock.calls.length && path === '/workspace/drafts') return [
        { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
        { name: 'docs', path: '/workspace/drafts/docs', kind: 'folder' },
      ];
      if (mocks.moveWorkspaceEntry.mock.calls.length && path === '/workspace/drafts/docs') return [
        { name: 'plan.md', path: '/workspace/drafts/docs/plan.md', kind: 'md' },
        { name: 'report.pages', path: '/workspace/drafts/docs/report.pages', kind: 'document' },
      ];
      return defaultList?.(path);
    });
    render(<App />);
    const report = await screen.findByRole('button', { name: 'report.pages' });
    fireEvent.click(report);
    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledWith(
      '/workspace/docs/report.pages',
      expect.any(Object),
      expect.any(Number),
    ));
    mocks.showEmbeddedQuickLook.mockClear();

    fireEvent.contextMenu(screen.getByRole('button', { name: 'docs' }), {
      clientX: 80,
      clientY: 100,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));

    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledWith(
      '/workspace/drafts/docs/report.pages',
      expect.any(Object),
      expect.any(Number),
    ));
    expect(screen.getByText('/workspace/drafts/docs/report.pages')).toBeTruthy();
    expect(mocks.hideEmbeddedQuickLook).toHaveBeenCalled();
  });

  it('converges when the watcher rename arrives before the command response', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    const defaultList = mocks.listDirectory.getMockImplementation();
    let committed = false;
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (committed && path === '/workspace/docs') return [
        { name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' },
      ];
      if (committed && path === '/workspace/drafts') return [
        { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
        { name: 'report.pages', path: '/workspace/drafts/report.pages', kind: 'document' },
      ];
      return defaultList?.(path);
    });
    const commit = deferred<{
      originalPath: string;
      movedPath: string;
      entry: { name: string; path: string; kind: 'document' };
    }>();
    mocks.moveWorkspaceEntry.mockReturnValueOnce(commit.promise);
    render(<App />);
    const report = await screen.findByRole('button', { name: 'report.pages' });
    fireEvent.contextMenu(report, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce());

    act(() => mocks.workspaceChangeHandler?.({
      rootPath: '/workspace',
      generation: 1,
      events: [{
        kind: 'rename',
        paths: ['/workspace/docs/report.pages', '/workspace/drafts/report.pages'],
      }],
    }));
    committed = true;
    await act(async () => commit.resolve({
      originalPath: '/workspace/docs/report.pages',
      movedPath: '/workspace/drafts/report.pages',
      entry: { name: 'report.pages', path: '/workspace/drafts/report.pages', kind: 'document' },
    }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'report.pages' }).dataset.treePath)
      .toBe('/workspace/drafts/report.pages'));
    expect(screen.getAllByRole('button', { name: 'report.pages' })).toHaveLength(1);
  });

  it('holds related watcher batches and collapses the 33rd batch into one bounded rescan', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    const defaultList = mocks.listDirectory.getMockImplementation();
    let committed = false;
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (committed && path === '/workspace/docs') return [
        { name: 'plan.md', path: '/workspace/docs/plan.md', kind: 'md' },
      ];
      if (committed && path === '/workspace/drafts') return [
        { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
        { name: 'report.pages', path: '/workspace/drafts/report.pages', kind: 'document' },
      ];
      return defaultList?.(path);
    });
    const commit = deferred<{
      originalPath: string;
      movedPath: string;
      entry: { name: string; path: string; kind: 'document' };
    }>();
    mocks.moveWorkspaceEntry.mockReturnValueOnce(commit.promise);
    render(<App />);
    const report = await screen.findByRole('button', { name: 'report.pages' });
    mocks.listDirectory.mockClear();
    fireEvent.contextMenu(report, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce());

    act(() => {
      for (let index = 0; index < 33; index += 1) {
        mocks.workspaceChangeHandler?.({
          rootPath: '/workspace',
          generation: 1,
          events: [{ kind: 'modify', paths: ['/workspace/docs/report.pages'] }],
        });
      }
    });
    expect(mocks.listDirectory).not.toHaveBeenCalled();

    committed = true;
    await act(async () => commit.resolve({
      originalPath: '/workspace/docs/report.pages',
      movedPath: '/workspace/drafts/report.pages',
      entry: { name: 'report.pages', path: '/workspace/drafts/report.pages', kind: 'document' },
    }));
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalled());
    expect(mocks.listDirectory.mock.calls.length).toBeLessThanOrEqual(6);
    expect(screen.getByRole('button', { name: 'report.pages' }).dataset.treePath)
      .toBe('/workspace/drafts/report.pages');
  });

  it('holds descendant watcher batches while moving a folder and bounds the rescan', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 1, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseMoveDestination.mockResolvedValue('/workspace/drafts');
    const defaultList = mocks.listDirectory.getMockImplementation();
    let committed = false;
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (!committed) return defaultList?.(path);
      if (path === '/workspace') return [
        { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
      ];
      if (path === '/workspace/drafts') return [
        { name: 'docs', path: '/workspace/drafts/docs', kind: 'folder' },
        { name: 'older.md', path: '/workspace/drafts/older.md', kind: 'md' },
      ];
      if (path === '/workspace/drafts/docs') return [
        { name: 'plan.md', path: '/workspace/drafts/docs/plan.md', kind: 'md' },
        { name: 'report.pages', path: '/workspace/drafts/docs/report.pages', kind: 'document' },
      ];
      return [];
    });
    const commit = deferred<{
      originalPath: string;
      movedPath: string;
      entry: { name: string; path: string; kind: 'folder' };
    }>();
    mocks.moveWorkspaceEntry.mockReturnValueOnce(commit.promise);
    render(<App />);
    const docs = await screen.findByRole('button', { name: 'docs' });
    mocks.listDirectory.mockClear();
    fireEvent.contextMenu(docs, { clientX: 80, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce());

    act(() => {
      for (let index = 0; index < 33; index += 1) {
        mocks.workspaceChangeHandler?.({
          rootPath: '/workspace',
          generation: 1,
          events: [{ kind: 'modify', paths: ['/workspace/docs/nested/deep.md'] }],
        });
      }
    });
    expect(mocks.listDirectory).not.toHaveBeenCalled();

    committed = true;
    await act(async () => commit.resolve({
      originalPath: '/workspace/docs',
      movedPath: '/workspace/drafts/docs',
      entry: { name: 'docs', path: '/workspace/drafts/docs', kind: 'folder' },
    }));
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalled());
    expect(mocks.listDirectory.mock.calls.length).toBeLessThanOrEqual(8);
    expect(screen.getByRole('button', { name: 'plan.md' }).dataset.treePath)
      .toBe('/workspace/drafts/docs/plan.md');
  });
});

describe('autosave, live tree, Trash, and session lifecycle', () => {
  it('autosaves once after the 600 ms idle window', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: 'editor' });
    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: '# rapid 1' } });
      fireEvent.change(editor, { target: { value: '# rapid 2' } });
      await act(async () => vi.advanceTimersByTimeAsync(599));
      expect(mocks.writeTextFile).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
      expect(mocks.writeTextFile).toHaveBeenCalledWith('/workspace/docs/plan.md', '# rapid 2', 'v1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes once when one formatting-style onChange enters the 600 ms coordinator', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: 'editor' });
    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: '**disk**' } });
      await act(async () => vi.advanceTimersByTimeAsync(600));
      expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
      expect(mocks.writeTextFile).toHaveBeenCalledWith(
        '/workspace/docs/plan.md',
        '**disk**',
        'v1',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes a changed loaded directory without folding the selected subtree', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 7, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const defaultList = mocks.listDirectory.getMockImplementation();
    let changed = false;
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/workspace' && changed) return Promise.resolve([
        { name: 'docs', path: '/workspace/docs', kind: 'folder' },
        { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
        { name: 'new.md', path: '/workspace/new.md', kind: 'md' },
      ]);
      return defaultList?.(path);
    });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    changed = true;
    await act(async () => mocks.workspaceChangeHandler?.({
      rootPath: '/workspace',
      generation: 7,
      events: [{ kind: 'create', paths: ['/workspace/new.md'] }],
    }));
    expect(await screen.findByRole('button', { name: 'new.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'docs' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'plan.md' }).getAttribute('aria-current')).toBe('page');
  });

  it('reconciles a watcher event received before the frontend binding commits', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 7, watching: true });
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const firstRoot = deferred<Array<{ name: string; path: string; kind: 'folder' }>>();
    const defaultList = mocks.listDirectory.getMockImplementation();
    let rootReads = 0;
    mocks.listDirectory.mockImplementation((path: string) => {
      if (path === '/workspace') {
        rootReads += 1;
        if (rootReads === 1) return firstRoot.promise;
        return Promise.resolve([
          { name: 'docs', path: '/workspace/docs', kind: 'folder' },
          { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
          { name: 'new.md', path: '/workspace/new.md', kind: 'md' },
        ]);
      }
      return defaultList?.(path);
    });
    render(<App />);
    await waitFor(() => expect(rootReads).toBe(1));
    await waitFor(() => expect(mocks.workspaceChangeHandler).toBeTruthy());
    act(() => mocks.workspaceChangeHandler?.({
      rootPath: '/workspace',
      generation: 7,
      events: [{ kind: 'create', paths: ['/workspace/new.md'] }],
    }));
    firstRoot.resolve([
      { name: 'docs', path: '/workspace/docs', kind: 'folder' },
      { name: 'drafts', path: '/workspace/drafts', kind: 'folder' },
    ]);

    expect(await screen.findByRole('button', { name: 'new.md' })).toBeTruthy();
    expect(rootReads).toBeGreaterThanOrEqual(2);
  });

  it('ignores a stale paired-rename read failure after another file is selected', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValueOnce({ content: '# plan', version: 'v1' });
    const renamedRead = deferred<{ content: string; version: string }>();
    mocks.readTextFile.mockImplementationOnce(() => renamedRead.promise);
    render(<App />);
    await screen.findByText('workspace / plan.md');
    act(() => mocks.workspaceChangeHandler?.({
      rootPath: '/workspace',
      generation: 1,
      events: [{ kind: 'rename', paths: ['/workspace/docs/plan.md', '/workspace/docs/renamed.md'] }],
    }));
    await screen.findByText('workspace / renamed.md');
    await userEvent.click(screen.getByRole('button', { name: 'report.pages' }));
    await screen.findByText('workspace / report.pages');
    renamedRead.reject({ code: 'FILE_NOT_FOUND', message: 'gone' });
    await act(async () => Promise.resolve());

    expect(screen.getByText('workspace / report.pages')).toBeTruthy();
    expect(screen.queryByText('改名后的文件已不存在，本地内容仍保留')).toBeNull();
  });

  it('reloads loaded directories in place without choosing or replacing the workspace', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.setWorkspaceRoot.mockClear();
    mocks.chooseFolder.mockClear();
    await userEvent.click(screen.getByRole('button', { name: '工作区菜单' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '重新载入目录' }));
    await waitFor(() => expect(screen.getByText('目录已重新载入')).toBeTruthy());
    expect(mocks.setWorkspaceRoot).not.toHaveBeenCalled();
    expect(mocks.chooseFolder).not.toHaveBeenCalled();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
  });

  it('closes tree and project menus when the Markdown table tools open', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const trigger = await screen.findByRole('button', { name: '表格' });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'plan.md' }), {
      clientX: 80,
      clientY: 100,
    });
    expect(screen.getByRole('menuitem', { name: '移到废纸篓' })).toBeTruthy();
    fireEvent.click(trigger);
    expect(await screen.findByRole('menu', { name: 'Markdown 表格' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '移到废纸篓' })).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '工作区菜单' }));
    expect(screen.getByRole('menuitem', { name: '重新载入目录' })).toBeTruthy();
    fireEvent.click(trigger);
    expect(await screen.findByRole('menu', { name: 'Markdown 表格' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '重新载入目录' })).toBeNull();
  });

  it('moves a right-clicked file to Trash and clears its selected editor', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const user = userEvent.setup();
    render(<App />);
    const plan = await screen.findByRole('button', { name: 'plan.md' });
    fireEvent.contextMenu(plan, { clientX: 80, clientY: 100 });
    await user.click(screen.getByRole('menuitem', { name: '移到废纸篓' }));
    await user.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalledWith(expect.objectContaining({
      originalPath: '/workspace/docs/plan.md',
      workspaceGeneration: 1,
    })));
    expect(screen.queryByRole('button', { name: 'plan.md' })).toBeNull();
    expect(screen.getByText('workspace / LocalView')).toBeTruthy();
  });

  it('preserves the selected document and restores focus when Trash fails', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    mocks.moveToTrash.mockRejectedValueOnce({ code: 'IO_ERROR', message: 'TRASH_FAILED: denied' });
    const user = userEvent.setup();
    render(<App />);
    const plan = await screen.findByRole('button', { name: 'plan.md' });
    fireEvent.contextMenu(plan, { clientX: 80, clientY: 100 });
    await user.click(screen.getByRole('menuitem', { name: '移到废纸篓' }));
    await user.click(await screen.findByRole('button', { name: '移到废纸篓' }));

    await screen.findByText('移到废纸篓失败：denied');
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'plan.md' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(plan));
  });

  it('does not flush the current draft when trashing an unrelated file', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# unsaved plan');
    const report = screen.getByRole('button', { name: 'report.pages' });
    fireEvent.contextMenu(report, { clientX: 80, clientY: 100 });
    await user.click(screen.getByRole('menuitem', { name: '移到废纸篓' }));
    await user.click(await screen.findByRole('button', { name: '移到废纸篓' }));

    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalled());
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.queryByText('移到废纸篓前无法保存')).toBeNull();
  });

  it('keeps the document selected on a transient watcher read error', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValueOnce({ content: '# plan', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.readTextFile.mockRejectedValueOnce({ code: 'PERMISSION_DENIED', message: 'permission denied' });
    act(() => mocks.workspaceChangeHandler?.({
      rootPath: '/workspace',
      generation: 1,
      events: [{ kind: 'modify', paths: ['/workspace/docs/plan.md'] }],
    }));

    await screen.findByText('暂时无法读取磁盘文件：permission denied');
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'plan.md' }).getAttribute('aria-current')).toBe('page');
  });

  it('warns when the committed workspace has no live watcher', async () => {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockResolvedValue({ path: '/workspace', generation: 9, watching: false });
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    render(<App />);
    await screen.findByText('目录实时监听不可用；可使用“重新载入目录”');
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
  });

  it('blocks beforeunload while a desktop edit is still waiting for auto-save', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# plan', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# immediate draft');
    const event = new Event('beforeunload', { cancelable: true });

    expect(window.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('restores a bounded workspace session once under StrictMode', async () => {
    mocks.desktop = true;
    mocks.getWindowBootstrap.mockResolvedValue({
      initialPath: null,
      sessionId: 'testprocess.restore',
      restoreMode: 'last-active',
    });
    mocks.readTextFile.mockResolvedValue({ content: '# restored', version: 'v1' });
    localStorage.setItem('localview.workspace-session.v1', JSON.stringify({
      version: 1,
      rootPath: '/workspace',
      selectedPath: '/workspace/docs/plan.md',
      openFolders: ['/workspace/docs'],
      mode: 'split',
    }));
    render(<StrictMode><App /></StrictMode>);
    await screen.findByText('workspace / plan.md');
    expect(mocks.setWorkspaceRoot).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '分栏' }).className).toContain('active');
    expect(screen.getByRole('button', { name: 'docs' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('multi-window entry and application quit coordination', () => {
  it('marks the titlebar as a deep native drag region without marking action buttons', () => {
    const { container } = render(<App />);
    const titlebar = container.querySelector<HTMLElement>('.titlebar');
    expect(titlebar?.getAttribute('data-tauri-drag-region')).toBe('deep');
    titlebar?.querySelectorAll('button').forEach((button) => {
      expect(button.hasAttribute('data-tauri-drag-region')).toBe(false);
    });
  });

  it('opens one new window from the project menu without flushing or changing the current draft', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# local draft');

    await user.click(screen.getByRole('button', { name: '工作区菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '新建窗口' }));

    await waitFor(() => expect(mocks.createWorkspaceWindow).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# local draft');
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('handles one Command-N event exactly once and reports builder errors in the current window', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.createWorkspaceWindow.mockRejectedValueOnce(new Error('WINDOW_CREATE_FAILED'));
    render(<StrictMode><App /></StrictMode>);
    await screen.findByText('workspace / plan.md');

    fireEvent.keyDown(window, { key: 'n', metaKey: true });

    await waitFor(() => expect(mocks.createWorkspaceWindow).toHaveBeenCalledOnce());
    expect(await screen.findByText('新建窗口失败：WINDOW_CREATE_FAILED')).toBeTruthy();
  });

  it('replies saved for a clean window', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await waitFor(() => expect(mocks.quitRequestHandler).toBeTypeOf('function'));

    act(() => mocks.quitRequestHandler?.({ generation: 11 }));

    await waitFor(() => expect(mocks.respondAppQuit).toHaveBeenCalledWith(11, 'saved'));
  });

  it('keeps dirty content through discard approval and a later application-wide abort', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.writeTextFile.mockRejectedValue({
      code: 'EXTERNAL_CHANGE',
      message: 'EXTERNAL_CHANGE: disk changed',
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# keep this draft');

    act(() => mocks.quitRequestHandler?.({ generation: 12 }));
    await user.click(await screen.findByRole('button', { name: '退出时放弃' }));
    await waitFor(() => expect(mocks.respondAppQuit).toHaveBeenCalledWith(12, 'discardApproved'));
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# keep this draft');

    act(() => mocks.quitAbortHandler?.({ generation: 12 }));

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('disabled', false));
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('value', '# keep this draft');
    expect(localStorage.getItem('localview.workspace-session.v2.testprocess.0')).not.toBeNull();
  });

  it('cancels immediately while a workspace transition is in flight', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    mocks.chooseFolder.mockResolvedValue('/other');
    const transition = deferred<{
      path: string;
      generation: number;
      watching: boolean;
      assetScope: string;
    }>();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('workspace / plan.md');
    mocks.setWorkspaceRoot.mockReturnValueOnce(transition.promise);
    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => expect(mocks.setWorkspaceRoot).toHaveBeenCalledWith('/other'));

    act(() => mocks.quitRequestHandler?.({ generation: 13 }));

    await waitFor(() => expect(mocks.respondAppQuit).toHaveBeenCalledWith(13, 'cancel'));
    transition.resolve({ path: '/other', generation: 2, watching: true, assetScope: 'other-scope' });
  });

  it('invalidates a slow flush when an external open aborts the quit transaction', async () => {
    mocks.desktop = true;
    mocks.readTextFile.mockResolvedValue({ content: '# disk', version: 'v1' });
    const slowSave = deferred<string>();
    mocks.writeTextFile.mockReturnValueOnce(slowSave.promise);
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await editCurrentDocument('# slow draft');

    act(() => mocks.quitRequestHandler?.({ generation: 14 }));
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledOnce());
    act(() => mocks.quitAbortHandler?.({ generation: 14 }));
    slowSave.resolve('v2');
    await act(async () => {
      await slowSave.promise;
      await Promise.resolve();
    });

    expect(mocks.respondAppQuit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('disabled', false);
  });
});

describe('folder multi-selection and batch operations', () => {
  const base = '/workspace/docs';
  const path = (name: string) => `${base}/${name}`;
  const row = (name: string) => document.querySelector<HTMLElement>(`.tree-row-main[data-tree-path="${path(name)}"]`)!;
  const pressed = () => [...document.querySelectorAll<HTMLElement>('.tree-row-main[aria-pressed="true"]')]
    .map((element) => element.dataset.treePath);

  async function readyFolders() {
    mocks.desktop = true;
    mocks.setWorkspaceRoot.mockImplementation(async (value: string) => ({
      path: value, generation: 1, watching: true, assetScope: 'synthetic-test-scope',
    }));
    mocks.readTextFile.mockResolvedValue({ content: '# synthetic document', version: 'v1' });
    let entries: import('./lib/desktop').DesktopEntry[] = [
      { name: 'docs', path: '/workspace/docs', kind: 'folder' },
      ...['alpha', 'beta', 'gamma', 'target'].map((name) => ({ name, path: path(name), kind: 'folder' as const })),
      { name: 'plan.md', path: path('plan.md'), kind: 'md' },
      { name: 'child.md', path: path('alpha/child.md'), kind: 'md' },
    ];
    mocks.listDirectory.mockImplementation(async (directory: string) => entries.filter((entry) =>
      entry.path.slice(0, entry.path.lastIndexOf('/')) === directory));
    mocks.moveToTrash.mockImplementation(async (candidate: { originalPath: string }) => {
      entries = entries.filter((entry) => entry.path !== candidate.originalPath && !entry.path.startsWith(`${candidate.originalPath}/`));
      return { originalPath: candidate.originalPath, trashedPath: `/synthetic-trash/${candidate.originalPath.split('/').pop()}` };
    });
    mocks.prepareWorkspaceMove.mockImplementation(async (sourcePath: string, destinationDirectory: string) => ({
      sourcePath, destinationDirectory, destinationPath: `${destinationDirectory}/${sourcePath.split('/').pop()}`,
      workspaceGeneration: 1, sourceParentIdentity: '1:10', sourceIdentity: '1:11', destinationIdentity: '1:12',
      sourceIsDirectory: entries.find((entry) => entry.path === sourcePath)?.kind === 'folder', sourceIsBundle: false,
    }));
    mocks.moveWorkspaceEntry.mockImplementation(async (candidate: { sourcePath: string; destinationPath: string }) => {
      const source = entries.find((entry) => entry.path === candidate.sourcePath)!;
      entries = entries.map((entry) => entry.path === candidate.sourcePath || entry.path.startsWith(`${candidate.sourcePath}/`)
        ? { ...entry, path: candidate.destinationPath + entry.path.slice(candidate.sourcePath.length) } : entry);
      return { originalPath: candidate.sourcePath, movedPath: candidate.destinationPath, entry: { ...source, path: candidate.destinationPath } };
    });
    render(<App />);
    await screen.findByText('workspace / plan.md');
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' }).hasAttribute('disabled')).toBe(false));
    expect(row('alpha')).toBeTruthy();
  }

  function select(...names: string[]) {
    fireEvent.keyDown(row('plan.md'), { key: 'Escape' });
    names.forEach((name) => fireEvent.click(row(name), { metaKey: true }));
  }
  function menu(name: string) {
    fireEvent.contextMenu(row(name), { clientX: 30, clientY: 60 });
  }
  async function trash(name: string) {
    menu(name);
    fireEvent.click(screen.getByRole('menuitem', { name: '移到废纸篓' }));
    await screen.findByRole('alertdialog');
  }
  async function move(name: string) {
    mocks.chooseMoveDestination.mockResolvedValue(path('target'));
    menu(name);
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到文件夹…' }));
  }

  it('selects nested directories without opening them or replacing the current document', async () => {
    await readyFolders();
    const reads = mocks.readTextFile.mock.calls.length;
    select('alpha', 'beta');
    expect(pressed()).toEqual([path('alpha'), path('beta')]);
    expect(row('alpha').getAttribute('aria-expanded')).toBe('false');
    expect(mocks.listDirectory).not.toHaveBeenCalledWith(path('alpha'));
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
    expect(mocks.readTextFile).toHaveBeenCalledTimes(reads);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('supports Shift ranges, Ctrl toggling, select-all and Escape within the visible tree', async () => {
    await readyFolders();
    select('alpha');
    fireEvent.click(row('gamma'), { shiftKey: true });
    expect(pressed()).toEqual([path('alpha'), path('beta'), path('gamma')]);
    fireEvent.click(row('beta'), { ctrlKey: true });
    expect(pressed()).toEqual([path('alpha'), path('gamma')]);
    fireEvent.keyDown(row('gamma'), { key: 'a', metaKey: true });
    expect(pressed()).toContain(path('target'));
    expect(pressed()).not.toContain(path('alpha/child.md'));
    fireEvent.keyDown(row('gamma'), { key: 'Escape' });
    fireEvent.keyDown(row('gamma'), { key: 'Backspace', metaKey: true });
    expect(pressed()).toEqual([]);
    expect(mocks.prepareTrash).not.toHaveBeenCalled();
  });

  it('preserves a selected group for context actions and replaces it for an unselected row', async () => {
    await readyFolders();
    select('alpha', 'beta');
    menu('alpha');
    expect(pressed()).toEqual([path('alpha'), path('beta')]);
    expect(screen.queryByRole('menuitem', { name: '重命名' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '新建文件夹' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    menu('gamma');
    expect(pressed()).toEqual([path('gamma')]);
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeTruthy();
  });

  it('asks once and cancellation never trashes any selected directory', async () => {
    await readyFolders();
    select('alpha', 'beta');
    await trash('alpha');
    expect(screen.getByText('将 2 项移到废纸篓？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(pressed()).toEqual([path('alpha'), path('beta')]);
  });

  it('trashes both selected directories after one confirmation without saving an unrelated document', async () => {
    await readyFolders();
    select('alpha', 'beta');
    await trash('alpha');
    fireEvent.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(row('alpha')).toBeNull());
    expect(row('beta')).toBeNull();
    expect(row('gamma')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
  });

  it('deduplicates a selected folder and its selected descendant before preparing Trash', async () => {
    await readyFolders();
    fireEvent.click(row('alpha'));
    await waitFor(() => expect(row('alpha/child.md')).toBeTruthy());
    select('alpha', 'alpha/child.md');
    await trash('alpha');
    fireEvent.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalledOnce());
    expect(mocks.prepareTrash.mock.calls.map(([value]) => value)).toEqual([path('alpha')]);
  });

  it('stops a partially failed Trash batch and keeps the failed and unattempted rows selected', async () => {
    await readyFolders();
    const perform = mocks.moveToTrash.getMockImplementation()!;
    mocks.moveToTrash.mockImplementation(async (candidate: { originalPath: string }) => {
      if (candidate.originalPath === path('beta')) throw new Error('PERMISSION_DENIED');
      return perform(candidate);
    });
    select('alpha', 'beta', 'gamma');
    await trash('alpha');
    fireEvent.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(pressed()).toEqual([path('beta'), path('gamma')]));
    expect(row('alpha')).toBeNull();
    expect(mocks.moveToTrash.mock.calls.map(([candidate]) => candidate.originalPath)).toEqual([path('alpha'), path('beta')]);
    expect(screen.getByText(/1\/3 项/)).toBeTruthy();
  });

  it('uses one destination picker and moves every selected directory', async () => {
    await readyFolders();
    select('alpha', 'beta');
    await move('alpha');
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(pressed()).toEqual([path('target/alpha'), path('target/beta')]));
    expect(mocks.chooseMoveDestination).toHaveBeenCalledOnce();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(row('alpha')).toBeNull();
    expect(row('beta')).toBeNull();
    expect(screen.getByText('workspace / plan.md')).toBeTruthy();
  });

  it('preflights every source before moving any item', async () => {
    await readyFolders();
    const prepare = mocks.prepareWorkspaceMove.getMockImplementation()!;
    mocks.prepareWorkspaceMove.mockImplementation(async (source: string, destination: string) => {
      if (source === path('beta')) throw new Error('MOVE_DESTINATION_EXISTS');
      return prepare(source, destination);
    });
    select('alpha', 'beta');
    await move('alpha');
    await screen.findByText(/批量移动已停止/);
    expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();
    expect(pressed()).toEqual([path('alpha'), path('beta')]);
  });

  it('stops moving after a late native collision and reports confirmed progress only', async () => {
    await readyFolders();
    const perform = mocks.moveWorkspaceEntry.getMockImplementation()!;
    mocks.moveWorkspaceEntry.mockImplementation(async (candidate: { sourcePath: string }) => {
      if (candidate.sourcePath === path('beta')) throw new Error('MOVE_DESTINATION_EXISTS');
      return perform(candidate);
    });
    select('alpha', 'beta', 'gamma');
    await move('alpha');
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(pressed()).toEqual([path('beta'), path('gamma')]));
    expect(mocks.moveWorkspaceEntry.mock.calls.map(([candidate]) => candidate.sourcePath)).toEqual([path('alpha'), path('beta')]);
    expect(screen.getByText(/已确认移动 1\/3 项/)).toBeTruthy();
  });

  it('does not move any item if the included current document cannot be saved safely', async () => {
    await readyFolders();
    mocks.writeTextFile.mockRejectedValue(new Error('IO_ERROR: synthetic save failure'));
    await editCurrentDocument('# unsaved synthetic draft');
    select('alpha', 'beta', 'plan.md');
    await move('alpha');
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalled());
    await screen.findByText(/无法移动当前项目/);
    expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'editor' }) as HTMLTextAreaElement).value).toBe('# unsaved synthetic draft');
  });


  it('captures Trash identities after atomic save for an included dirty file', async () => {
    await readyFolders();
    const pendingSave = deferred<string>();
    let identity = 'before-save';
    mocks.writeTextFile.mockImplementation(async () => {
      const version = await pendingSave.promise;
      identity = 'after-save';
      return version;
    });
    const prepare = mocks.prepareTrash.getMockImplementation()!;
    mocks.prepareTrash.mockImplementation(async (value: string) => ({
      ...await prepare(value), targetIdentity: value === path('plan.md') ? identity : 'folder',
    }));
    const perform = mocks.moveToTrash.getMockImplementation()!;
    mocks.moveToTrash.mockImplementation(async (candidate: { originalPath: string; targetIdentity: string }) => {
      if (candidate.originalPath === path('plan.md') && candidate.targetIdentity !== identity) {
        throw new Error('TRASH_TARGET_CHANGED');
      }
      return perform(candidate);
    });
    await editCurrentDocument('# dirty synthetic file');
    select('alpha', 'plan.md');
    menu('alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledOnce());
    expect(mocks.prepareTrash).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => pendingSave.resolve('v2'));
    await screen.findByRole('alertdialog');
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(row('plan.md')).toBeNull());
    expect(row('alpha')).toBeNull();
    expect(mocks.moveToTrash).toHaveBeenCalledTimes(2);
    expect(mocks.moveToTrash.mock.calls[1][0].targetIdentity).toBe('after-save');
  });

  it('saves before single-item Trash preflight and cancellation preserves the file', async () => {
    await readyFolders();
    const calls: string[] = [];
    mocks.writeTextFile.mockImplementation(async () => { calls.push('save'); return 'v2'; });
    const prepare = mocks.prepareTrash.getMockImplementation()!;
    mocks.prepareTrash.mockImplementation(async (value: string) => { calls.push('prepare'); return prepare(value); });
    await editCurrentDocument('# single dirty file');
    select('plan.md');
    await trash('plan.md');
    expect(calls).toEqual(['save', 'prepare']);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(row('plan.md')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('disabled', false));
  });

  it('never refreshes a Trash identity after confirmation when the selected file was replaced', async () => {
    await readyFolders();
    let identity = 'original';
    const prepare = mocks.prepareTrash.getMockImplementation()!;
    mocks.prepareTrash.mockImplementation(async (value: string) => ({ ...await prepare(value), targetIdentity: identity }));
    mocks.moveToTrash.mockImplementation(async (candidate: { targetIdentity: string }) => {
      if (candidate.targetIdentity !== identity) throw new Error('TRASH_TARGET_CHANGED');
      throw new Error('Unexpected mutation');
    });
    select('alpha', 'beta');
    await trash('alpha');
    identity = 'external-replacement';
    fireEvent.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalledOnce());
    await screen.findByText(/0\/2 项/);
    expect(mocks.prepareTrash).toHaveBeenCalledTimes(2);
    expect(row('alpha')).toBeTruthy();
    expect(row('beta')).toBeTruthy();
    expect(pressed()).toEqual([path('alpha'), path('beta')]);
  });

  it('retains every preflighted move identity when a later source is replaced', async () => {
    await readyFolders();
    let betaIdentity = 'original-beta';
    const prepare = mocks.prepareWorkspaceMove.getMockImplementation()!;
    mocks.prepareWorkspaceMove.mockImplementation(async (source: string, destination: string) => ({
      ...await prepare(source, destination), sourceIdentity: source === path('beta') ? betaIdentity : 'original-alpha',
    }));
    const perform = mocks.moveWorkspaceEntry.getMockImplementation()!;
    mocks.moveWorkspaceEntry.mockImplementation(async (candidate: { sourcePath: string; sourceIdentity: string }) => {
      if (candidate.sourcePath === path('alpha')) {
        const result = await perform(candidate);
        betaIdentity = 'replacement-beta';
        return result;
      }
      if (candidate.sourceIdentity !== betaIdentity) throw new Error('MOVE_SOURCE_CHANGED');
      return perform(candidate);
    });
    select('alpha', 'beta');
    await move('alpha');
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledTimes(2));
    await screen.findByText(/已确认移动 1\/2 项/);
    expect(mocks.prepareWorkspaceMove).toHaveBeenCalledTimes(2);
    expect(mocks.moveWorkspaceEntry.mock.calls[1][0].sourceIdentity).toBe('original-beta');
    expect(row('beta')).toBeTruthy();
    expect(row('target/beta')).toBeNull();
    expect(pressed()).toEqual([path('beta')]);
  });

  it('keeps delete shortcuts inside the editor away from the tree selection', async () => {
    await readyFolders();
    const editor = await editCurrentDocument('# editable text');
    select('alpha', 'beta');
    fireEvent.keyDown(editor, { key: 'Backspace', metaKey: true });
    expect(mocks.prepareTrash).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
