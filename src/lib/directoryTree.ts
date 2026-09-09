import type { DesktopEntry } from './desktop';
import { normalizePath, parentPath } from './desktop';

export type DirectoryTreeNode = DesktopEntry & {
  children?: DirectoryTreeNode[];
  loaded?: boolean;
  demoContent?: string;
};

function sortNodes<T extends DesktopEntry>(nodes: T[]): T[] {
  return [...nodes].sort((left, right) => {
    const folderOrder = Number(right.kind === 'folder') - Number(left.kind === 'folder');
    if (folderOrder !== 0) return folderOrder;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

function findTreePath<T extends DirectoryTreeNode>(nodes: T[], path: string): T | null {
  const target = normalizePath(path);
  for (const node of nodes) {
    if (normalizePath(node.path) === target) return node;
    const nested = node.children ? findTreePath(node.children as T[], target) : null;
    if (nested) return nested;
  }
  return null;
}

export function containsPath(parent: string, target: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget === normalizedParent) return true;
  if (normalizedParent === '/') return normalizedTarget.startsWith('/');
  const separator = normalizedParent.endsWith('/') ? '' : '/';
  return normalizedTarget.startsWith(`${normalizedParent}${separator}`);
}

export function mergeDirectoryEntries<T extends DirectoryTreeNode>(existing: T[] | undefined, incoming: DesktopEntry[]): T[] {
  const previous = new Map((existing ?? []).map((node) => [normalizePath(node.path), node]));
  return sortNodes(incoming.map((entry) => {
    const old = previous.get(normalizePath(entry.path));
    if (!old || old.kind !== entry.kind) return { ...entry, loaded: entry.kind !== 'folder' } as T;
    return {
      ...old,
      ...entry,
      children: entry.kind === 'folder' ? old.children : undefined,
      loaded: entry.kind === 'folder' ? old.loaded : true,
    } as T;
  }));
}

export function loadedDirectoryPaths(nodes: DirectoryTreeNode[], rootPath: string): Set<string> {
  const paths = new Set<string>();
  const root = normalizePath(rootPath);
  if (root) paths.add(root);
  const visit = (items: DirectoryTreeNode[]) => {
    for (const node of items) {
      if (node.kind !== 'folder' || !node.loaded) continue;
      paths.add(normalizePath(node.path));
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return paths;
}

export function directoryRefreshTargets(eventPaths: string[], loaded: Set<string>, rootPath: string): Set<string> {
  const root = normalizePath(rootPath);
  const targets = new Set<string>();
  for (const rawPath of eventPaths) {
    const path = normalizePath(rawPath);
    if (!containsPath(root, path)) continue;
    if (loaded.has(path)) targets.add(path);
    const parent = parentPath(path);
    if (loaded.has(parent)) targets.add(parent);
    if (path === root) targets.add(root);
  }
  return targets;
}

export function replaceDirectoryWithMergedEntries<T extends DirectoryTreeNode>(
  nodes: T[],
  rootPath: string,
  directoryPath: string,
  entries: DesktopEntry[],
): T[] {
  const root = normalizePath(rootPath);
  const directory = normalizePath(directoryPath);
  if (root === directory) return mergeDirectoryEntries(nodes, entries);
  return nodes.map((node) => {
    if (normalizePath(node.path) === directory && node.kind === 'folder') {
      return { ...node, loaded: true, children: mergeDirectoryEntries(node.children, entries) } as T;
    }
    return node.children
      ? { ...node, children: replaceDirectoryWithMergedEntries(node.children as T[], root, directory, entries) } as T
      : node;
  });
}

export function applyDirectoryResultsInDepthOrder<T extends DirectoryTreeNode>(
  nodes: T[],
  rootPath: string,
  results: Map<string, DesktopEntry[]>,
): T[] {
  const visit = (existing: T[] | undefined, directoryPath: string): T[] => {
    const entries = results.get(normalizePath(directoryPath));
    const merged = entries ? mergeDirectoryEntries(existing, entries) : [...(existing ?? [])];
    return merged.map((node) => {
      if (node.kind !== 'folder') return node;
      const path = normalizePath(node.path);
      if (!node.children && !results.has(path)) return node;
      return {
        ...node,
        loaded: results.has(path) ? true : node.loaded,
        children: visit(node.children as T[] | undefined, path),
      } as T;
    });
  };
  return visit(nodes, normalizePath(rootPath));
}

export function removeTreePath<T extends DirectoryTreeNode>(nodes: T[], path: string): T[] {
  const target = normalizePath(path);
  return nodes
    .filter((node) => normalizePath(node.path) !== target)
    .map((node) => node.children ? { ...node, children: removeTreePath(node.children as T[], target) } as T : node);
}

export function replaceTreePathPrefix<T extends DirectoryTreeNode>(nodes: T[], oldPath: string, newPath: string): T[] {
  const oldPrefix = normalizePath(oldPath);
  const newPrefix = normalizePath(newPath);
  const migrate = (path: string) => {
    const normalized = normalizePath(path);
    return containsPath(oldPrefix, normalized) ? `${newPrefix}${normalized.slice(oldPrefix.length)}` : normalized;
  };
  return nodes.map((node) => {
    const nextPath = migrate(node.path);
    return {
      ...node,
      path: nextPath,
      name: normalizePath(node.path) === oldPrefix ? newPrefix.slice(newPrefix.lastIndexOf('/') + 1) : node.name,
      children: node.children ? replaceTreePathPrefix(node.children as T[], oldPrefix, newPrefix) : node.children,
    } as T;
  });
}

export function moveTreeEntry<T extends DirectoryTreeNode>(
  nodes: T[],
  rootPath: string,
  originalPath: string,
  entry: DesktopEntry,
): T[] {
  const root = normalizePath(rootPath);
  const source = normalizePath(originalPath);
  const destination = normalizePath(entry.path);
  const destinationDirectory = parentPath(destination);
  if (!root
    || source === root
    || !containsPath(root, source)
    || !containsPath(root, destination)
    || parentPath(source) === destinationDirectory) return nodes;
  const sourceEntry = findTreePath(nodes, source);
  const destinationEntry = findTreePath(nodes, destination);
  if (sourceEntry && destinationEntry) return nodes;
  const existing = sourceEntry ?? destinationEntry;
  if ((existing?.kind === 'folder' || entry.kind === 'folder')
    && containsPath(source, destinationDirectory)) return nodes;
  const targetExists = destinationDirectory === root
    || findTreePath(nodes, destinationDirectory)?.kind === 'folder';
  if (!targetExists) return nodes;

  const migrated = existing?.kind === 'folder'
    ? replaceTreePathPrefix([existing], source, destination)[0]
    : existing;
  const moved = entry.kind === 'folder'
    ? {
        ...(migrated ?? {}),
        ...entry,
        children: migrated?.children,
        loaded: migrated?.loaded ?? false,
      } as T
    : {
        ...(migrated ?? {}),
        ...entry,
        children: undefined,
        loaded: true,
      } as T;
  const withoutSource = removeTreePath(removeTreePath(nodes, source), destination);
  if (destinationDirectory === root) return sortNodes([...withoutSource, moved]);

  const insert = (items: T[]): T[] => items.map((node) => {
    if (normalizePath(node.path) === destinationDirectory && node.kind === 'folder') {
      return {
        ...node,
        children: sortNodes([...((node.children as T[] | undefined) ?? []), moved]),
      } as T;
    }
    return node.children
      ? { ...node, children: insert(node.children as T[]) } as T
      : node;
  });
  return insert(withoutSource);
}

export function renameTreeEntry<T extends DirectoryTreeNode>(
  nodes: T[],
  rootPath: string,
  originalPath: string,
  entry: DesktopEntry,
): T[] {
  const root = normalizePath(rootPath);
  const source = normalizePath(originalPath);
  const destination = normalizePath(entry.path);
  const directory = parentPath(source);
  if (!root
    || source === root
    || source === destination
    || !containsPath(root, source)
    || !containsPath(root, destination)
    || parentPath(destination) !== directory) return nodes;

  const sourceEntry = findTreePath(nodes, source);
  if (!sourceEntry || findTreePath(nodes, destination)) return nodes;
  const migrated = sourceEntry.kind === 'folder'
    ? replaceTreePathPrefix([sourceEntry], source, destination)[0]
    : sourceEntry;
  const renamed = entry.kind === 'folder'
    ? {
        ...migrated,
        ...entry,
        children: migrated.children,
        loaded: migrated.loaded ?? false,
      } as T
    : {
        ...migrated,
        ...entry,
        children: undefined,
        loaded: true,
      } as T;

  const replaceInDirectory = (items: T[], currentDirectory: string): T[] => {
    if (normalizePath(currentDirectory) === directory) {
      return sortNodes([
        ...items.filter((node) => normalizePath(node.path) !== source),
        renamed,
      ]);
    }
    return items.map((node) => node.kind === 'folder' && node.children
      ? {
          ...node,
          children: replaceInDirectory(node.children as T[], node.path),
        } as T
      : node);
  };
  return replaceInDirectory(nodes, root);
}
