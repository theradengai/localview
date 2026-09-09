import { describe, expect, it } from 'vitest';
import { MAX_INLINE_RENAMES, reduceWorkspaceChanges } from './workspaceChangeReducer';

const tree = [{
  name: 'old', path: '/root/old', kind: 'folder' as const, loaded: true,
  children: [{ name: 'a.md', path: '/root/old/a.md', kind: 'md' as const, loaded: true }],
}];

describe('reduceWorkspaceChanges', () => {
  it('coalesces paired rename state into one pure result', () => {
    const result = reduceWorkspaceChanges({
      tree,
      openFolders: new Set(['/root/old']),
      createDraft: { id: 1, parentPath: '/root/old' },
      renameDraft: { id: 2, sourcePath: '/root/old/a.md' },
      rootPath: '/root',
      selectedPath: '/root/old/a.md',
      batch: {
        rootPath: '/root',
        generation: 1,
        events: [{ kind: 'rename', paths: ['/root/old', '/root/new'] }],
      },
    });
    expect(result.tree[0].path).toBe('/root/new');
    expect(result.openFolders).toEqual(new Set(['/root/new']));
    expect(result.createDraft?.parentPath).toBe('/root/new');
    expect(result.renameDraft?.sourcePath).toBe('/root/new/a.md');
    expect(result.pairedRenames).toEqual([['/root/old', '/root/new']]);
  });

  it('degrades a rename flood to one loaded-directory rescan', () => {
    const result = reduceWorkspaceChanges({
      tree,
      openFolders: new Set(['/root/old']),
      createDraft: null,
      renameDraft: null,
      rootPath: '/root',
      selectedPath: '/root/old/a.md',
      batch: {
        rootPath: '/root',
        generation: 1,
        events: Array.from({ length: MAX_INLINE_RENAMES + 1 }, (_, index) => ({
          kind: 'rename' as const,
          paths: [`/root/old-${index}`, `/root/new-${index}`],
        })),
      },
    });
    expect(result.tree).toBe(tree);
    expect(result.refreshTargets).toEqual(new Set(['/root', '/root/old']));
    expect(result.selectedNeedsRecheck).toBe(true);
    expect(result.pairedRenames).toEqual([]);
  });

  it('cancels a draft when its source is renamed or removed', () => {
    const renamed = reduceWorkspaceChanges({
      tree,
      openFolders: new Set(['/root/old']),
      createDraft: null,
      renameDraft: { id: 3, sourcePath: '/root/old/a.md' },
      rootPath: '/root',
      selectedPath: null,
      batch: {
        rootPath: '/root',
        generation: 1,
        events: [{ kind: 'rename', paths: ['/root/old/a.md', '/root/old/b.md'] }],
      },
    });
    expect(renamed.renameDraft).toBeNull();

    const removed = reduceWorkspaceChanges({
      tree,
      openFolders: new Set(['/root/old']),
      createDraft: null,
      renameDraft: { id: 4, sourcePath: '/root/old/a.md' },
      rootPath: '/root',
      selectedPath: null,
      batch: {
        rootPath: '/root',
        generation: 1,
        events: [{ kind: 'remove', paths: ['/root/old/a.md'] }],
      },
    });
    expect(removed.renameDraft).toBeNull();
  });

  it('cancels a draft on rescan because the source identity is unknown', () => {
    const result = reduceWorkspaceChanges({
      tree,
      openFolders: new Set(['/root/old']),
      createDraft: null,
      renameDraft: { id: 5, sourcePath: '/root/old/a.md' },
      rootPath: '/root',
      selectedPath: null,
      batch: {
        rootPath: '/root',
        generation: 1,
        events: [{ kind: 'rescan', paths: ['/root'] }],
      },
    });
    expect(result.renameDraft).toBeNull();
  });
});
