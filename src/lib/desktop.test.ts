import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }));

import {
  createMarkdownFile,
  listenForWorkspaceChanges,
  listenForWorkspaceWatchFailures,
  moveToTrash,
  prepareHtmlPreview,
  prepareTrash,
  previewAssetUrl,
  resolveMarkdownAssetSource,
  releaseHtmlPreview,
  setWorkspaceRoot,
} from './desktop';

describe('createMarkdownFile desktop contract', () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
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

  it('returns the workspace generation binding unchanged', async () => {
    const binding = { path: '/workspace', generation: 7, watching: true };
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
    const browser = { desktop: false, rootPath: '/workspace', selectedPath: '/workspace/docs/readme.md' };
    expect(resolveMarkdownAssetSource('../images/a.png?size=2', browser)).toBe('../images/a.png?size=2');
    expect(resolveMarkdownAssetSource('https://example.com/a.png', browser)).toBe('https://example.com/a.png');
    expect(resolveMarkdownAssetSource('data:image/png;base64,AA==', browser)).toBe('data:image/png;base64,AA==');
    expect(resolveMarkdownAssetSource('#diagram', browser)).toBe('#diagram');
    expect(resolveMarkdownAssetSource('//cdn.example.com/a.png', browser)).toBe('//cdn.example.com/a.png');

    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const desktop = { ...browser, desktop: true };
    expect(resolveMarkdownAssetSource('../images/a.png', desktop)).toBe('localview://localhost/images/a.png');
    expect(resolveMarkdownAssetSource('/images/a.png', desktop)).toBe('localview://localhost/images/a.png');
    expect(resolveMarkdownAssetSource('../../outside.png', desktop)).toBe('');
    expect(resolveMarkdownAssetSource('', desktop)).toBe('');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
