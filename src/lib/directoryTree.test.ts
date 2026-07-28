import { describe, expect, it } from 'vitest';
import type { DesktopEntry } from './desktop';
import {
  applyDirectoryResultsInDepthOrder,
  containsPath,
  directoryRefreshTargets,
  loadedDirectoryPaths,
  mergeDirectoryEntries,
  replaceTreePathPrefix,
  type DirectoryTreeNode,
} from './directoryTree';

describe('directory tree helpers', () => {
  it('treats filesystem roots as path ancestors', () => {
    expect(containsPath('/', '/notes.md')).toBe(true);
    expect(containsPath('/root', '/rooted/file.md')).toBe(false);
    expect(containsPath('C:/', 'C:/docs/file.md')).toBe(true);
  });

  it('preserves loaded folder descendants while applying disk metadata', () => {
    const existing: DirectoryTreeNode[] = [{
      name: 'docs', path: '/root/docs', kind: 'folder', loaded: true,
      children: [{ name: 'old.md', path: '/root/docs/old.md', kind: 'md', loaded: true }],
    }];
    const merged = mergeDirectoryEntries(existing, [
      { name: 'docs', path: '/root/docs', kind: 'folder' },
      { name: 'README.md', path: '/root/README.md', kind: 'md' },
    ]);
    expect(merged[0]).toMatchObject({ path: '/root/docs', loaded: true });
    expect(merged[0].children?.[0].path).toBe('/root/docs/old.md');
  });

  it('targets only loaded directories affected by events', () => {
    const tree: DirectoryTreeNode[] = [
      { name: 'docs', path: '/root/docs', kind: 'folder', loaded: true, children: [] },
      { name: 'cold', path: '/root/cold', kind: 'folder', loaded: false },
    ];
    const loaded = loadedDirectoryPaths(tree, '/root');
    expect([...directoryRefreshTargets(['/root/docs/new.md', '/root/cold/new.md'], loaded, '/root')]).toEqual(['/root/docs']);
  });

  it('applies parent before child so both authoritative results survive', () => {
    const initial: DirectoryTreeNode[] = [{ name: 'docs', path: '/root/docs', kind: 'folder', loaded: true, children: [] }];
    const rootEntries: DesktopEntry[] = [{ name: 'docs', path: '/root/docs', kind: 'folder' }];
    const childEntries: DesktopEntry[] = [{ name: 'new.md', path: '/root/docs/new.md', kind: 'md' }];
    const next = applyDirectoryResultsInDepthOrder(initial, '/root', new Map([
      ['/root/docs', childEntries],
      ['/root', rootEntries],
    ]));
    expect(next[0].children?.[0].path).toBe('/root/docs/new.md');
  });

  it('migrates descendant paths for a paired folder rename', () => {
    const tree: DirectoryTreeNode[] = [{
      name: 'old', path: '/root/old', kind: 'folder', loaded: true,
      children: [{ name: 'a.md', path: '/root/old/a.md', kind: 'md' }],
    }];
    const next = replaceTreePathPrefix(tree, '/root/old', '/root/new');
    expect(next[0]).toMatchObject({ name: 'new', path: '/root/new' });
    expect(next[0].children?.[0].path).toBe('/root/new/a.md');
  });
});
