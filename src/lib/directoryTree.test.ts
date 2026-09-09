import { describe, expect, it } from 'vitest';
import type { DesktopEntry } from './desktop';
import {
  applyDirectoryResultsInDepthOrder,
  containsPath,
  directoryRefreshTargets,
  loadedDirectoryPaths,
  mergeDirectoryEntries,
  moveTreeEntry,
  renameTreeEntry,
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

  it('moves file-like entries between loaded folders and keeps Finder sorting', () => {
    const tree: DirectoryTreeNode[] = [
      {
        name: 'a', path: '/root/a', kind: 'folder', loaded: true,
        children: [{ name: 'z.md', path: '/root/a/z.md', kind: 'md', loaded: true }],
      },
      {
        name: 'b', path: '/root/b', kind: 'folder', loaded: true,
        children: [{ name: 'B.md', path: '/root/b/B.md', kind: 'md', loaded: true }],
      },
    ];
    const entry: DesktopEntry = { name: 'z.md', path: '/root/b/z.md', kind: 'md' };
    const next = moveTreeEntry(tree, '/root', '/root/a/z.md', entry);
    expect(next[0].children).toEqual([]);
    expect(next[1].children?.map((node) => node.name)).toEqual(['B.md', 'z.md']);
    expect(moveTreeEntry(next, '/root', '/root/a/z.md', entry)).toEqual(next);
  });

  it('moves entries to root and preserves a known child in an unloaded destination', () => {
    const tree: DirectoryTreeNode[] = [
      {
        name: 'cold', path: '/root/cold', kind: 'folder', loaded: false,
      },
      { name: 'root.md', path: '/root/root.md', kind: 'md', loaded: true },
      {
        name: 'source', path: '/root/source', kind: 'folder', loaded: true,
        children: [
          { name: 'a.md', path: '/root/source/a.md', kind: 'md', loaded: true },
          { name: 'b.md', path: '/root/source/b.md', kind: 'md', loaded: true },
        ],
      },
    ];
    const intoCold = moveTreeEntry(tree, '/root', '/root/source/b.md', {
      name: 'b.md', path: '/root/cold/b.md', kind: 'md',
    });
    const cold = intoCold.find((node) => node.path === '/root/cold');
    expect(cold).toMatchObject({ loaded: false });
    expect(cold?.children?.[0].path).toBe('/root/cold/b.md');

    const intoRoot = moveTreeEntry(intoCold, '/root', '/root/source/a.md', {
      name: 'a.md', path: '/root/a.md', kind: 'md',
    });
    expect(intoRoot.map((node) => node.name)).toEqual(['cold', 'source', 'a.md', 'root.md']);
  });

  it('moves loaded folders with their descendants and rewritten paths', () => {
    const tree: DirectoryTreeNode[] = [
      {
        name: 'source', path: '/root/source', kind: 'folder', loaded: true,
        children: [{
          name: 'nested', path: '/root/source/nested', kind: 'folder', loaded: true,
          children: [{ name: 'a.md', path: '/root/source/nested/a.md', kind: 'md', loaded: true }],
        }],
      },
      { name: 'target', path: '/root/target', kind: 'folder', loaded: false },
    ];
    const next = moveTreeEntry(tree, '/root', '/root/source', {
      name: 'source', path: '/root/target/source', kind: 'folder',
    });
    expect(next.map((node) => node.name)).toEqual(['target']);
    expect(next[0].children?.[0]).toMatchObject({
      name: 'source', path: '/root/target/source', kind: 'folder', loaded: true,
    });
    expect(next[0].children?.[0].children?.[0].path).toBe('/root/target/source/nested');
    expect(next[0].children?.[0].children?.[0].children?.[0].path)
      .toBe('/root/target/source/nested/a.md');

    const movedToRoot = moveTreeEntry(next, '/root', '/root/target/source', {
      name: 'source', path: '/root/source', kind: 'folder',
    });
    expect(movedToRoot.map((node) => node.name)).toEqual(['source', 'target']);
    expect(movedToRoot[0].children?.[0].children?.[0].path).toBe('/root/source/nested/a.md');
    expect(moveTreeEntry(movedToRoot, '/root', '/root/target/source', {
      name: 'source', path: '/root/source', kind: 'folder',
    })).toEqual(movedToRoot);
  });

  it('fails closed for folder descendants, outside paths, and missing destination folders', () => {
    const tree: DirectoryTreeNode[] = [
      { name: 'a.md', path: '/root/a.md', kind: 'md', loaded: true },
      {
        name: 'folder', path: '/root/folder', kind: 'folder', loaded: true,
        children: [
          { name: 'child', path: '/root/folder/child', kind: 'folder', loaded: true },
          { name: 'a.md', path: '/root/folder/a.md', kind: 'md', loaded: true },
        ],
      },
    ];
    expect(moveTreeEntry(tree, '/root', '/root/folder', {
      name: 'folder', path: '/root/folder/child/folder', kind: 'folder',
    })).toBe(tree);
    expect(moveTreeEntry(tree, '/root', '/root/a.md', {
      name: 'a.md', path: '/root/a.md', kind: 'md',
    })).toBe(tree);
    expect(moveTreeEntry(tree, '/root', '/root/a.md', {
      name: 'a.md', path: '/root/folder/a.md', kind: 'md',
    })).toBe(tree);
    expect(moveTreeEntry(tree, '/root', '/outside/a.md', {
      name: 'a.md', path: '/root/a.md', kind: 'md',
    })).toBe(tree);
    expect(moveTreeEntry(tree, '/root', '/root/a.md', {
      name: 'a.md', path: '/root/missing/a.md', kind: 'md',
    })).toBe(tree);
  });

  it('renames and reorders a same-parent file while preserving demo content', () => {
    const tree: DirectoryTreeNode[] = [
      { name: 'b.md', path: '/root/b.md', kind: 'md', loaded: true, demoContent: 'draft' },
      { name: 'z.md', path: '/root/z.md', kind: 'md', loaded: true },
    ];
    const next = renameTreeEntry(tree, '/root', '/root/z.md', {
      name: 'a.md', path: '/root/a.md', kind: 'md',
    });
    expect(next.map((node) => node.name)).toEqual(['a.md', 'b.md']);
    const renamedDemo = renameTreeEntry(next, '/root', '/root/b.md', {
      name: 'c.md', path: '/root/c.md', kind: 'md',
    });
    expect(renamedDemo.find((node) => node.name === 'c.md')?.demoContent).toBe('draft');
  });

  it('renames a loaded folder and rewrites every loaded descendant path', () => {
    const tree: DirectoryTreeNode[] = [{
      name: 'old', path: '/root/old', kind: 'folder', loaded: true,
      children: [{
        name: 'nested', path: '/root/old/nested', kind: 'folder', loaded: true,
        children: [{ name: 'a.md', path: '/root/old/nested/a.md', kind: 'md', loaded: true }],
      }],
    }];
    const next = renameTreeEntry(tree, '/root', '/root/old', {
      name: 'new', path: '/root/new', kind: 'folder',
    });
    expect(next[0]).toMatchObject({ name: 'new', path: '/root/new', loaded: true });
    expect(next[0].children?.[0].path).toBe('/root/new/nested');
    expect(next[0].children?.[0].children?.[0].path).toBe('/root/new/nested/a.md');
  });

  it('keeps an unloaded folder unloaded after rename', () => {
    const tree: DirectoryTreeNode[] = [{
      name: 'cold', path: '/root/cold', kind: 'folder', loaded: false,
    }];
    const next = renameTreeEntry(tree, '/root', '/root/cold', {
      name: 'renamed', path: '/root/renamed', kind: 'folder',
    });
    expect(next[0]).toMatchObject({ path: '/root/renamed', loaded: false });
    expect(next[0].children).toBeUndefined();
  });

  it('fails closed for root, outside, cross-parent, collision, missing, and no-op rename', () => {
    const tree: DirectoryTreeNode[] = [
      { name: 'a.md', path: '/root/a.md', kind: 'md', loaded: true },
      { name: 'b.md', path: '/root/b.md', kind: 'md', loaded: true },
      { name: 'folder', path: '/root/folder', kind: 'folder', loaded: false },
    ];
    for (const [source, target] of [
      ['/root', '/root/new'],
      ['/outside/a.md', '/root/c.md'],
      ['/root/a.md', '/root/folder/a.md'],
      ['/root/a.md', '/root/b.md'],
      ['/root/missing.md', '/root/c.md'],
      ['/root/a.md', '/root/a.md'],
    ]) {
      expect(renameTreeEntry(tree, '/root', source, {
        name: target.slice(target.lastIndexOf('/') + 1), path: target, kind: 'md',
      })).toBe(tree);
    }
  });
});
