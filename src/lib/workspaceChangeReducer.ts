import type { WorkspaceChangeBatch } from './desktop';
import { normalizePath, parentPath } from './desktop';
import {
  containsPath,
  directoryRefreshTargets,
  loadedDirectoryPaths,
  replaceTreePathPrefix,
  type DirectoryTreeNode,
} from './directoryTree';

export const MAX_INLINE_RENAMES = 16;

export type WorkspaceChangeResult<
  T extends DirectoryTreeNode,
  D extends { parentPath: string },
  R extends { sourcePath: string },
> = {
  tree: T[];
  openFolders: Set<string>;
  createDraft: D | null;
  renameDraft: R | null;
  refreshTargets: Set<string>;
  pairedRenames: Array<[string, string]>;
  selectedNeedsRecheck: boolean;
};

export function reduceWorkspaceChanges<
  T extends DirectoryTreeNode,
  D extends { parentPath: string },
  R extends { sourcePath: string },
>(input: {
  tree: T[];
  openFolders: Set<string>;
  createDraft: D | null;
  renameDraft: R | null;
  batch: WorkspaceChangeBatch;
  rootPath: string;
  selectedPath: string | null;
}): WorkspaceChangeResult<T, D, R> {
  let tree = input.tree;
  let openFolders = input.openFolders;
  let createDraft = input.createDraft;
  let renameDraft = input.renameDraft;
  let loaded = loadedDirectoryPaths(tree, input.rootPath);
  const refreshTargets = new Set<string>();
  const pairedRenames: Array<[string, string]> = [];
  let selectedNeedsRecheck = false;
  const inlineRenames = input.batch.events
    .filter((event) => event.kind === 'rename' && event.paths.length === 2)
    .length <= MAX_INLINE_RENAMES;

  for (const event of input.batch.events) {
    if (event.kind === 'rescan') {
      loaded.forEach((path) => refreshTargets.add(path));
      renameDraft = null;
      continue;
    }
    if (event.kind === 'rename' && event.paths.length === 2) {
      const [oldPath, newPath] = event.paths.map(normalizePath);
      if (!inlineRenames) {
        loaded.forEach((path) => refreshTargets.add(path));
        selectedNeedsRecheck = true;
        continue;
      }
      tree = replaceTreePathPrefix(tree, oldPath, newPath) as T[];
      openFolders = new Set([...openFolders].map((path) => containsPath(oldPath, path)
        ? `${newPath}${normalizePath(path).slice(oldPath.length)}`
        : path));
      if (createDraft && containsPath(oldPath, createDraft.parentPath)) {
        createDraft = {
          ...createDraft,
          parentPath: `${newPath}${normalizePath(createDraft.parentPath).slice(oldPath.length)}`,
        };
      }
      if (renameDraft) {
        const draftPath = normalizePath(renameDraft.sourcePath);
        if (draftPath === oldPath) {
          renameDraft = null;
        } else if (containsPath(oldPath, draftPath)) {
          renameDraft = {
            ...renameDraft,
            sourcePath: `${newPath}${draftPath.slice(oldPath.length)}`,
          };
        }
      }
      loaded = loadedDirectoryPaths(tree, input.rootPath);
      refreshTargets.add(parentPath(oldPath));
      refreshTargets.add(parentPath(newPath));
      if (loaded.has(newPath)) refreshTargets.add(newPath);
      pairedRenames.push([oldPath, newPath]);
      continue;
    }
    if (renameDraft && event.kind === 'remove' && event.paths.some((path) => (
      containsPath(path, renameDraft!.sourcePath)
    ))) renameDraft = null;
    if (input.selectedPath && event.paths.some((path) => containsPath(path, input.selectedPath!))) {
      selectedNeedsRecheck = true;
    }
    directoryRefreshTargets(event.paths, loaded, input.rootPath)
      .forEach((path) => refreshTargets.add(path));
  }

  return {
    tree,
    openFolders,
    createDraft,
    renameDraft,
    refreshTargets,
    pairedRenames,
    selectedNeedsRecheck,
  };
}
