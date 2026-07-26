import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_SESSION_KEY,
  clearWorkspaceSession,
  flushWorkspaceSession,
  queueWorkspaceSession,
  readWorkspaceSession,
  sanitizeWorkspaceSession,
  writeWorkspaceSession,
} from './workspaceSession';

describe('workspace session', () => {
  beforeEach(() => clearWorkspaceSession());
  afterEach(() => vi.useRealTimers());

  it('keeps only bounded paths inside the workspace', () => {
    const session = sanitizeWorkspaceSession({
      version: 1,
      rootPath: '/root',
      selectedPath: '/outside/file.md',
      openFolders: [...Array.from({ length: 140 }, (_, index) => `/root/${index}`), '/outside'],
      mode: 'split',
    });
    expect(session?.selectedPath).toBeNull();
    expect(session?.openFolders).toHaveLength(128);
    expect(session?.openFolders).not.toContain('/outside');
  });

  it('drops overlong and malformed values without throwing', () => {
    expect(sanitizeWorkspaceSession({ version: 1, rootPath: `/${'a'.repeat(4096)}` })).toBeNull();
    localStorage.setItem(WORKSPACE_SESSION_KEY, '{bad');
    expect(readWorkspaceSession()).toBeNull();
    expect(localStorage.getItem(WORKSPACE_SESSION_KEY)).toBeNull();
  });

  it('writes root state synchronously', () => {
    writeWorkspaceSession({ rootPath: '/root', selectedPath: null, openFolders: [], mode: 'preview' });
    expect(readWorkspaceSession()).toMatchObject({ rootPath: '/root', version: 1 });
  });

  it('debounces UI state and flushes it synchronously on close', () => {
    vi.useFakeTimers();
    queueWorkspaceSession({ rootPath: '/root', selectedPath: '/root/a.md', openFolders: ['/root/docs'], mode: 'edit' });
    expect(localStorage.getItem(WORKSPACE_SESSION_KEY)).toBeNull();
    flushWorkspaceSession();
    expect(readWorkspaceSession()).toMatchObject({ selectedPath: '/root/a.md', mode: 'edit' });
  });

  it('does not let an old root debounce overwrite a synchronous new root', async () => {
    vi.useFakeTimers();
    writeWorkspaceSession({ rootPath: '/old', selectedPath: null, openFolders: [], mode: 'preview' });
    queueWorkspaceSession({ rootPath: '/old', selectedPath: '/old/draft.md', openFolders: [], mode: 'edit' });

    writeWorkspaceSession({ rootPath: '/new', selectedPath: '/new/readme.md', openFolders: [], mode: 'preview' });
    await vi.runAllTimersAsync();
    flushWorkspaceSession();

    expect(readWorkspaceSession()).toMatchObject({ rootPath: '/new', selectedPath: '/new/readme.md' });
  });

  it('accepts descendants when the workspace is the filesystem root', () => {
    expect(sanitizeWorkspaceSession({
      version: 1,
      rootPath: '/',
      selectedPath: '/notes.md',
      openFolders: ['/docs'],
      mode: 'preview',
    })).toMatchObject({ selectedPath: '/notes.md', openFolders: ['/docs'] });
  });
});
