import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, listen, open } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ listen }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }));

import {
  createDirectory,
  chooseMoveDestination,
  createWorkspaceWindow,
  createMarkdownFile,
  finishWindowStartup,
  getWindowBootstrap,
  listenForAppQuitAborts,
  listenForAppQuitRequests,
  listenForOpenPath,
  listenForPrintRequests,
  listenForWindowOpenFailures,
  listenForWorkspaceChanges,
  listenForWorkspaceWatchFailures,
  moveToTrash,
  moveWorkspaceEntry,
  normalizeCommandError,
  prepareHtmlPreview,
  prepareTrash,
  prepareWorkspaceMove,
  prepareWorkspaceRename,
  printCurrentWindow,
  previewAssetUrl,
  reconcileWorkspaceRename,
  resolveMarkdownAssetSource,
  releaseHtmlPreview,
  reconcileWorkspaceMove,
  renameWorkspaceEntry,
  respondAppQuit,
  setWorkspaceRoot,
  type LocalViewErrorCode,
} from './desktop';

describe('createMarkdownFile desktop contract', () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    open.mockReset();
    window.sessionStorage.clear();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('invokes the exact Tauri command and returns its result unchanged', async () => {
    const created = {
      entry: { name: 'notes.md', path: '/workspace/notes.md', kind: 'md' as const },
      snapshot: { content: '', version: 'empty-v1' },
    };
    invoke.mockResolvedValue(created);

    await expect(createMarkdownFile('/workspace', 'notes')).resolves.toBe(created);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('create_markdown_file', {
      parentPath: '/workspace',
      name: 'notes',
    });
  });

  it('creates a directory through the exact caller-window command payload', async () => {
    const created = { name: 'Projects', path: '/workspace/Projects', kind: 'folder' as const };
    invoke.mockResolvedValue(created);

    await expect(createDirectory('/workspace', 'Projects')).resolves.toBe(created);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('create_directory', {
      parentPath: '/workspace',
      name: 'Projects',
    });
  });

  it('returns the workspace generation binding unchanged', async () => {
    const binding = { path: '/workspace', generation: 7, watching: true, assetScope: 'scope-7' };
    invoke.mockResolvedValue(binding);
    await expect(setWorkspaceRoot('/workspace')).resolves.toBe(binding);
    expect(invoke).toHaveBeenCalledWith('set_workspace_root', { path: '/workspace' });
  });

  it('forwards watcher payloads and returns the listener disposer', async () => {
    const dispose = vi.fn();
    let changeHandler: ((event: { payload: unknown }) => void) | undefined;
    let failureHandler: ((event: { payload: unknown }) => void) | undefined;
    listen.mockImplementation(async (name, handler) => {
      if (name === 'workspace-directory-changed') changeHandler = handler;
      if (name === 'workspace-watch-failed') failureHandler = handler;
      return dispose;
    });
    const onChange = vi.fn();
    const onFailure = vi.fn();
    await expect(listenForWorkspaceChanges(onChange)).resolves.toBe(dispose);
    await expect(listenForWorkspaceWatchFailures(onFailure)).resolves.toBe(dispose);
    const batch = { rootPath: '/workspace', generation: 2, events: [] };
    const failure = { rootPath: '/workspace', generation: 2, message: 'failed' };
    changeHandler?.({ payload: batch });
    failureHandler?.({ payload: failure });
    expect(onChange).toHaveBeenCalledWith(batch);
    expect(onFailure).toHaveBeenCalledWith(failure);
  });

  it('uses the current window for every window-scoped event listener', async () => {
    const dispose = vi.fn();
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    listen.mockImplementation(async (name, handler) => {
      handlers.set(name, handler);
      return dispose;
    });
    const onOpenPath = vi.fn();
    const onOpenFailure = vi.fn();
    const onQuitRequest = vi.fn();
    const onQuitAbort = vi.fn();
    const onPrintRequest = vi.fn();

    await expect(listenForOpenPath(onOpenPath)).resolves.toBe(dispose);
    await expect(listenForWindowOpenFailures(onOpenFailure)).resolves.toBe(dispose);
    await expect(listenForAppQuitRequests(onQuitRequest)).resolves.toBe(dispose);
    await expect(listenForAppQuitAborts(onQuitAbort)).resolves.toBe(dispose);
    await expect(listenForPrintRequests(onPrintRequest)).resolves.toBe(dispose);

    handlers.get('open-path')?.({ payload: '/workspace/a.md' });
    handlers.get('workspace-window-open-failed')?.({ payload: { path: null, message: 'failed' } });
    handlers.get('app-quit-requested')?.({ payload: { generation: 4 } });
    handlers.get('app-quit-aborted')?.({ payload: { generation: 4 } });
    handlers.get('print-requested')?.({ payload: undefined });
    expect(onOpenPath).toHaveBeenCalledWith('/workspace/a.md');
    expect(onOpenFailure).toHaveBeenCalledWith({ path: null, message: 'failed' });
    expect(onQuitRequest).toHaveBeenCalledWith({ generation: 4 });
    expect(onQuitAbort).toHaveBeenCalledWith({ generation: 4 });
    expect(onPrintRequest).toHaveBeenCalledOnce();
  });

  it('invokes the private bootstrap, new-window, and app-quit commands', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const bootstrap = {
      initialPath: null,
      sessionId: 'process.2',
      restoreMode: 'none' as const,
    };
    invoke
      .mockResolvedValueOnce(bootstrap)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('workspace-process-3')
      .mockResolvedValueOnce(undefined);

    await expect(getWindowBootstrap()).resolves.toBe(bootstrap);
    await expect(finishWindowStartup()).resolves.toBeUndefined();
    await expect(createWorkspaceWindow()).resolves.toBe('workspace-process-3');
    await expect(respondAppQuit(8, 'discardApproved')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenNthCalledWith(1, 'get_window_bootstrap');
    expect(invoke).toHaveBeenNthCalledWith(2, 'finish_window_startup');
    expect(invoke).toHaveBeenNthCalledWith(3, 'new_workspace_window');
    expect(invoke).toHaveBeenNthCalledWith(4, 'respond_app_quit', {
      generation: 8,
      outcome: 'discardApproved',
    });
  });

  it('prints through the caller-window command on desktop and window.print in browser', async () => {
    const browserPrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    await expect(printCurrentWindow()).resolves.toBeUndefined();
    expect(browserPrint).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();

    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    invoke.mockResolvedValueOnce(undefined);
    await expect(printCurrentWindow()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('print_current_window');
    browserPrint.mockRestore();
  });

  it('invokes recoverable Trash and returns the resulting path', async () => {
    const candidate = {
      originalPath: '/workspace/a.md',
      workspaceGeneration: 1,
      parentIdentity: '1:2',
      targetIdentity: '1:3',
      isDir: false,
    };
    const result = { originalPath: '/workspace/a.md', trashedPath: '/Users/me/.Trash/a.md' };
    invoke.mockResolvedValueOnce(candidate).mockResolvedValueOnce(result);
    await expect(prepareTrash('/workspace/a.md')).resolves.toBe(candidate);
    await expect(moveToTrash(candidate)).resolves.toBe(result);
    expect(invoke).toHaveBeenNthCalledWith(1, 'prepare_trash', { path: '/workspace/a.md' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'move_to_trash', { candidate });
  });

  it('uses exact caller-window workspace move payloads and reconciliation types', async () => {
    const moveErrorCodes: LocalViewErrorCode[] = [
      'MOVE_DESTINATION_INSIDE_SOURCE',
      'MOVE_SECURE_RENAME_UNAVAILABLE',
      'MOVE_BUNDLE_BOUNDARY',
      'MOVE_OUTCOME_UNCERTAIN',
    ];
    const candidate = {
      sourcePath: '/workspace/a.md',
      destinationDirectory: '/workspace/docs',
      destinationPath: '/workspace/docs/a.md',
      workspaceGeneration: 7,
      sourceParentIdentity: '1:2',
      sourceIdentity: '1:3',
      destinationIdentity: '1:4',
      sourceIsDirectory: false,
      sourceIsBundle: false,
    };
    const moved = {
      originalPath: candidate.sourcePath,
      movedPath: candidate.destinationPath,
      entry: { name: 'a.md', path: candidate.destinationPath, kind: 'md' as const },
    };
    const reconciliation = { outcome: 'destination' as const, entry: moved.entry };
    invoke
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(moved)
      .mockResolvedValueOnce(reconciliation);

    await expect(prepareWorkspaceMove(candidate.sourcePath, candidate.destinationDirectory))
      .resolves.toBe(candidate);
    await expect(moveWorkspaceEntry(candidate)).resolves.toBe(moved);
    await expect(reconcileWorkspaceMove(candidate)).resolves.toBe(reconciliation);
    expect(invoke).toHaveBeenNthCalledWith(1, 'prepare_workspace_move', {
      sourcePath: candidate.sourcePath,
      destinationDirectory: candidate.destinationDirectory,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'move_workspace_entry', { candidate });
    expect(invoke).toHaveBeenNthCalledWith(3, 'reconcile_workspace_move', { candidate });
    expect(normalizeCommandError({ code: moveErrorCodes[0], message: 'inside source' })).toEqual({
      code: 'MOVE_DESTINATION_INSIDE_SOURCE',
      message: 'inside source',
    });
    expect(moveErrorCodes).toHaveLength(4);
  });

  it('opens the native move destination picker inside the active workspace', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    open.mockResolvedValue('/workspace/docs');
    await expect(chooseMoveDestination('/workspace')).resolves.toBe('/workspace/docs');
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '移动到文件夹',
      defaultPath: '/workspace',
    });
  });

  it('uses exact caller-window workspace rename payloads and typed errors', async () => {
    const renameErrorCodes: LocalViewErrorCode[] = [
      'RENAME_INVALID_NAME',
      'RENAME_NAME_TOO_LONG',
      'RENAME_RESERVED_NAME',
      'RENAME_EXTENSION_CHANGE_UNSUPPORTED',
      'RENAME_CASE_ONLY_UNSUPPORTED',
      'RENAME_UNCHANGED',
      'RENAME_ROOT_FORBIDDEN',
      'RENAME_SOURCE_UNSUPPORTED',
      'RENAME_SOURCE_CHANGED',
      'RENAME_DESTINATION_EXISTS',
      'RENAME_PARENT_CHANGED',
      'RENAME_BUNDLE_BOUNDARY',
      'RENAME_SECURE_UNAVAILABLE',
      'RENAME_OUTCOME_UNCERTAIN',
    ];
    const candidate = {
      sourcePath: '/workspace/old.md',
      destinationPath: '/workspace/new.md',
      workspaceGeneration: 7,
      parentIdentity: '1:2',
      sourceIdentity: '1:3',
      sourceIsDirectory: false,
      sourceIsBundle: false,
    };
    const renamed = {
      originalPath: candidate.sourcePath,
      renamedPath: candidate.destinationPath,
      entry: { name: 'new.md', path: candidate.destinationPath, kind: 'md' as const },
    };
    const reconciliation = { outcome: 'destination' as const, entry: renamed.entry };
    invoke
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(renamed)
      .mockResolvedValueOnce(reconciliation);

    await expect(prepareWorkspaceRename(candidate.sourcePath, 'new.md')).resolves.toBe(candidate);
    await expect(renameWorkspaceEntry(candidate)).resolves.toBe(renamed);
    await expect(reconcileWorkspaceRename(candidate)).resolves.toBe(reconciliation);
    expect(invoke).toHaveBeenNthCalledWith(1, 'prepare_workspace_rename', {
      sourcePath: candidate.sourcePath,
      newName: 'new.md',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'rename_workspace_entry', { candidate });
    expect(invoke).toHaveBeenNthCalledWith(3, 'reconcile_workspace_rename', { candidate });
    expect(normalizeCommandError({ code: renameErrorCodes[4], message: 'case-only' })).toEqual({
      code: 'RENAME_CASE_ONLY_UNSUPPORTED',
      message: 'case-only',
    });
    expect(renameErrorCodes).toHaveLength(14);
  });

  it('prepares and releases an HTML preview capability', async () => {
    const capability = {
      token: 'preview-token',
      documentPath: '/workspace/index.html',
      workspaceGeneration: 4,
    };
    invoke.mockResolvedValueOnce(capability).mockResolvedValueOnce(undefined);

    await expect(prepareHtmlPreview('/workspace/index.html')).resolves.toBe(capability);
    await expect(releaseHtmlPreview('preview-token')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenNthCalledWith(1, 'prepare_html_preview', {
      path: '/workspace/index.html',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'release_html_preview', {
      token: 'preview-token',
    });
  });

  it('builds a capability-scoped preview asset URL', () => {
    expect(previewAssetUrl('/workspace/nested/index.html', '/workspace', 'preview token')).toBe(
      'localview://localhost/preview/preview%20token/nested/index.html',
    );
  });

  it('resolves Markdown assets consistently in browser and desktop contexts', () => {
    const browser = { desktop: false, rootPath: '/workspace', selectedPath: '/workspace/docs/readme.md', assetScope: 'scope-a' };
    expect(resolveMarkdownAssetSource('../images/a.png?size=2', browser)).toBe('../images/a.png?size=2');
    expect(resolveMarkdownAssetSource('https://example.com/a.png', browser)).toBe('https://example.com/a.png');
    expect(resolveMarkdownAssetSource('data:image/png;base64,AA==', browser)).toBe('data:image/png;base64,AA==');
    expect(resolveMarkdownAssetSource('#diagram', browser)).toBe('#diagram');
    expect(resolveMarkdownAssetSource('//cdn.example.com/a.png', browser)).toBe('//cdn.example.com/a.png');

    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const desktop = { ...browser, desktop: true };
    expect(resolveMarkdownAssetSource('../images/a.png', desktop)).toBe('localview://localhost/asset/scope-a/images/a.png');
    expect(resolveMarkdownAssetSource('/images/a.png', desktop)).toBe('localview://localhost/asset/scope-a/images/a.png');
    expect(resolveMarkdownAssetSource('../../outside.png', desktop)).toBe('');
    expect(resolveMarkdownAssetSource('', desktop)).toBe('');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
