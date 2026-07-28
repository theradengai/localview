import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAST_ACTIVE_WORKSPACE_SESSION_KEY,
  LEGACY_WORKSPACE_SESSION_KEY,
  WORKSPACE_SESSION_PREFIX,
  clearWorkspaceSession,
  flushWorkspaceSession,
  markWorkspaceSessionActive,
  queueWorkspaceSession,
  readWorkspaceSession,
  restoreLastActiveWorkspaceSession,
  sanitizeWorkspaceSession,
  writeWorkspaceSession,
} from './workspaceSession';

const session = (rootPath: string, selectedPath: string | null = null) => ({
  rootPath,
  selectedPath,
  openFolders: [],
  mode: 'preview' as const,
});

describe('workspace session v2', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps only bounded paths inside the workspace', () => {
    const result = sanitizeWorkspaceSession({
      version: 2,
      rootPath: '/root',
      selectedPath: '/outside/file.md',
      openFolders: [...Array.from({ length: 140 }, (_, index) => `/root/${index}`), '/outside'],
      mode: 'split',
    });
    expect(result?.selectedPath).toBeNull();
    expect(result?.openFolders).toHaveLength(128);
    expect(result?.openFolders).not.toContain('/outside');
  });

  it('drops overlong and malformed private values without throwing', () => {
    expect(sanitizeWorkspaceSession({ version: 2, rootPath: `/${'a'.repeat(4096)}` })).toBeNull();
    localStorage.setItem(`${WORKSPACE_SESSION_PREFIX}process.bad`, '{bad');
    expect(readWorkspaceSession('process.bad')).toBeNull();
    expect(localStorage.getItem(`${WORKSPACE_SESSION_PREFIX}process.bad`)).toBeNull();
  });

  it('writes each session synchronously without sharing a key', () => {
    writeWorkspaceSession('process.1', session('/one'));
    writeWorkspaceSession('process.2', session('/two'));
    expect(readWorkspaceSession('process.1')).toMatchObject({ rootPath: '/one', version: 2 });
    expect(readWorkspaceSession('process.2')).toMatchObject({ rootPath: '/two', version: 2 });
  });

  it('keeps debounce timers isolated by session id', async () => {
    vi.useFakeTimers();
    queueWorkspaceSession('timers.1', session('/one', '/one/a.md'));
    queueWorkspaceSession('timers.2', session('/two', '/two/b.md'));
    expect(readWorkspaceSession('timers.1')).toBeNull();
    flushWorkspaceSession('timers.1');
    expect(readWorkspaceSession('timers.1')?.selectedPath).toBe('/one/a.md');
    expect(readWorkspaceSession('timers.2')).toBeNull();
    await vi.runAllTimersAsync();
    expect(readWorkspaceSession('timers.2')?.selectedPath).toBe('/two/b.md');
  });

  it('does not let an old-root debounce overwrite a synchronous new root', async () => {
    vi.useFakeTimers();
    writeWorkspaceSession('roots.1', session('/old'));
    queueWorkspaceSession('roots.1', { ...session('/old', '/old/draft.md'), mode: 'edit' });
    clearWorkspaceSession('roots.1');
    writeWorkspaceSession('roots.1', session('/new', '/new/readme.md'));
    await vi.runAllTimersAsync();
    flushWorkspaceSession('roots.1');
    expect(readWorkspaceSession('roots.1')).toMatchObject({ rootPath: '/new', selectedPath: '/new/readme.md' });
  });

  it('writes and verifies the private snapshot before moving last-active', () => {
    localStorage.setItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY, 'active.old');
    expect(markWorkspaceSessionActive('active.1', session('/root'))).toBe(true);
    expect(readWorkspaceSession('active.1')?.rootPath).toBe('/root');
    expect(localStorage.getItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY)).toBe('active.1');

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(markWorkspaceSessionActive('active.2', session('/other'))).toBe(false);
    setItem.mockRestore();
    expect(localStorage.getItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY)).toBe('active.1');
  });

  it('migrates last-active while preserving current-process concurrent keys', () => {
    writeWorkspaceSession('oldprocess.9', session('/last'));
    writeWorkspaceSession('current.1', session('/one'));
    writeWorkspaceSession('current.2', session('/two'));
    localStorage.setItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY, 'oldprocess.9');

    expect(restoreLastActiveWorkspaceSession('current.0')).toMatchObject({ rootPath: '/last' });
    expect(localStorage.getItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY)).toBe('current.0');
    expect(readWorkspaceSession('current.0')?.rootPath).toBe('/last');
    expect(readWorkspaceSession('current.1')?.rootPath).toBe('/one');
    expect(readWorkspaceSession('current.2')?.rootPath).toBe('/two');
    expect(readWorkspaceSession('oldprocess.9')).toBeNull();
  });

  it('safely migrates the legacy v1 key once', () => {
    localStorage.setItem(LEGACY_WORKSPACE_SESSION_KEY, JSON.stringify({
      version: 1,
      ...session('/legacy', '/legacy/readme.md'),
    }));
    expect(restoreLastActiveWorkspaceSession('newprocess.0')).toMatchObject({
      version: 2,
      rootPath: '/legacy',
    });
    expect(localStorage.getItem(LEGACY_WORKSPACE_SESSION_KEY)).toBeNull();
  });

  it('accepts descendants when the workspace is the filesystem root', () => {
    expect(sanitizeWorkspaceSession({
      version: 2,
      rootPath: '/',
      selectedPath: '/notes.md',
      openFolders: ['/docs'],
      mode: 'preview',
    })).toMatchObject({ selectedPath: '/notes.md', openFolders: ['/docs'] });
  });
});
