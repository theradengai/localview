"""Apply reviewed, exact-anchor edits to the pinned LocalView base (development branch only)."""
from pathlib import Path
import hashlib


def load(path, expected):
    data = Path(path).read_bytes()
    actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if actual != expected:
        raise RuntimeError(f'{path}: base changed; refusing to overwrite ({actual})')
    return data.decode()


def replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected one exact anchor, got {text.count(old)}: {old[:100]!r}')
    return text.replace(old, new, 1)


app = load('src/App.tsx', 'e551730fd250896335ed2c5acdc217af83dbcd02')
tree = load('src/components/FileTree.tsx', '9eda49dafc04a6b5f4bae013161bbaad66fffad1')

tree = replace(tree, '  memo,\n', '  memo,\n  useCallback,\n  useMemo,\n  useState,\n')
tree = replace(tree, "import type { DesktopEntry }", "import { retainVisibleSelection, selectTreePaths } from '../lib/treeSelection';\nimport type { DesktopEntry }")
tree = replace(tree, '  selectedPath: string | null;\n', '  selectedPath: string | null;\n  selectionPaths?: readonly string[];\n  onSelectionChange?: (paths: string[]) => void;\n')
tree = replace(tree, '  onMoveStart: (node: FileTreeNode) => boolean;', '  onMoveStart: (node: FileTreeNode, selection?: FileTreeNode[]) => boolean;')
tree = replace(tree, '  selectedPath,\n', '  selectedPath,\n  selectionPaths,\n  onSelectionChange,\n')
tree = replace(tree, '  const rowRefs = useRef(new Map<string, HTMLDivElement>());', '''  const [fallbackSelection, setFallbackSelection] = useState<string[]>([]);
  const selection = selectionPaths ?? fallbackSelection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectionCallbackRef = useRef(onSelectionChange);
  selectionCallbackRef.current = onSelectionChange;
  const anchorRef = useRef<string | null>(null);
  const previousContextRef = useRef({ root: '', document: null as string | null });
  const visibleNodes = useMemo(() => {
    const result: FileTreeNode[] = [];
    const visit = (nodes: FileTreeNode[]) => nodes.forEach((node) => {
      result.push(node);
      if (node.kind === 'folder' && openFolders.has(normalizePath(node.path)) && node.children) visit(node.children);
    });
    visit(tree);
    return result;
  }, [tree, openFolders]);
  const visiblePaths = useMemo(() => visibleNodes.map((node) => normalizePath(node.path)), [visibleNodes]);
  const selectedPaths = new Set(selection);
  const replaceSelection = useCallback((paths: string[]) => {
    if (selectionRef.current.length === paths.length
      && selectionRef.current.every((path, index) => path === paths[index])) return;
    selectionRef.current = paths;
    setFallbackSelection(paths);
    selectionCallbackRef.current?.(paths);
  }, []);

  useLayoutEffect(() => {
    const root = normalizePath(rootPath);
    const document = selectedPath ? normalizePath(selectedPath) : null;
    const previous = previousContextRef.current;
    previousContextRef.current = { root, document };
    let next = retainVisibleSelection(selectionRef.current, visiblePaths);
    if (previous.root !== root || (previous.document !== document && !locked)) {
      next = document && visiblePaths.includes(document) ? [document] : [];
      anchorRef.current = next[0] ?? null;
    } else if (anchorRef.current && !visiblePaths.includes(anchorRef.current)) {
      anchorRef.current = null;
    }
    replaceSelection(next);
  }, [rootPath, selectedPath, visiblePaths, selection, locked, replaceSelection]);

  const selectRow = (path: string, modifiers: { toggle?: boolean; range?: boolean } = {}) => {
    const next = selectTreePaths(visiblePaths, selectionRef.current, anchorRef.current, path, modifiers);
    anchorRef.current = next.anchor;
    replaceSelection(next.paths);
  };
  const selectForAction = (path: string) => {
    if (!selectionRef.current.includes(path)) selectRow(path);
  };

  const rowRefs = useRef(new Map<string, HTMLDivElement>());''')
# Focus after creation or a completed operation; do not collapse an existing group.
tree = replace(tree, '''    rowRefs.current.get(normalizePath(focusPath))?.focus();
    onFocusHandled();''', '''    const path = normalizePath(focusPath);
    rowRefs.current.get(path)?.focus();
    if (!locked && visiblePaths.includes(path) && !selectionRef.current.includes(path)) {
      anchorRef.current = path;
      replaceSelection([path]);
    }
    onFocusHandled();''')
tree = replace(tree, '  }, [focusPath, onFocusHandled, tree]);', '  }, [focusPath, onFocusHandled, tree, locked, visiblePaths, replaceSelection]);')
tree = replace(tree, '''    const active = selectedPath !== null && normalizePath(selectedPath) === path;''', '''    const currentDocument = selectedPath !== null && normalizePath(selectedPath) === path;
    const active = selectedPaths.has(path);''')
tree = replace(tree, "          aria-current={active ? 'page' : undefined}", "          aria-current={currentDocument ? 'page' : undefined}\n          aria-pressed={active}")
tree = replace(tree, '''            if (event.detail > 1) return;
            if (!locked && !renaming) onNodeClick(node);''', '''            if (event.detail > 1 || locked || renaming || renameBusy) return;
            const modified = event.metaKey || event.ctrlKey || event.shiftKey;
            if (modified && (createDraft !== null || renameDraft !== null)) return;
            selectRow(path, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey });
            if (!modified) onNodeClick(node);''')
tree = replace(tree, '''            if (locked || renameBusy || createDraft !== null || renameDraft !== null) return;
            const target = event.target;''', '''            if (locked || renameBusy || createDraft !== null || renameDraft !== null
              || event.metaKey || event.ctrlKey || event.shiftKey || selectionRef.current.length > 1) return;
            const target = event.target;''')
tree = replace(tree, "            if (event.key === 'F2' && createDraft === null && renameDraft === null) {", '''            if (createDraft === null && renameDraft === null) {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                event.stopPropagation();
                anchorRef.current = path;
                replaceSelection([...visiblePaths]);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                anchorRef.current = null;
                replaceSelection([]);
                return;
              }
              if (!event.metaKey && !event.ctrlKey && !event.altKey
                && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const index = visiblePaths.indexOf(path);
                const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? visiblePaths.length - 1
                  : Math.max(0, Math.min(visiblePaths.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
                const nextPath = visiblePaths[nextIndex];
                if (nextPath) {
                  selectRow(nextPath, { range: event.shiftKey });
                  rowRefs.current.get(nextPath)?.focus();
                }
                return;
              }
              if ((event.key === ' ' || event.key === 'Enter')
                && (event.metaKey || event.ctrlKey || event.shiftKey)) {
                event.preventDefault();
                selectRow(path, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey });
                return;
              }
            }
            if (event.key === 'F2' && createDraft === null && renameDraft === null) {''')
tree = replace(tree, '''              event.preventDefault();
              onBeginRename(node);
              return;''', '''              event.preventDefault();
              if (selectionRef.current.length > 1) return;
              selectForAction(path);
              onBeginRename(node);
              return;''')
tree = replace(tree, '''            event.preventDefault();
            onNodeClick(node);
          }}''', '''            event.preventDefault();
            selectRow(path);
            onNodeClick(node);
          }}''')
tree = replace(tree, '''            onNodeContextMenu(event, node);''', '''            selectForAction(path);
            onNodeContextMenu(event, node);''')
tree = replace(tree, '''            if (!onMoveStart(node)) {''', '''            selectForAction(path);
            const dragSelection = visibleNodes.filter((item) => selectionRef.current.includes(normalizePath(item.path)));
            if (!onMoveStart(node, dragSelection)) {''')
tree = replace(tree, "            event.dataTransfer.setData('text/plain', path);", "            event.dataTransfer.setData('text/plain', dragSelection.map((item) => item.path).join('\\n'));")
tree = replace(tree, '            onClick={(event) => onOpenNodeMenu(event, node)}', '''            onClick={(event) => {
              selectForAction(path);
              onOpenNodeMenu(event, node);
            }}''')
tree = replace(tree, '  return <div className="file-tree">', '''  return <div className="file-tree" role="group" aria-label="文件与文件夹（支持多选）"
    onClick={(event) => {
      if (event.target === event.currentTarget && !locked && !createDraft && !renameDraft) {
        anchorRef.current = null;
        replaceSelection([]);
      }
    }}
  >''')

app = replace(app, "import './style.css';", "import { runTreeBatch, topLevelSelectedPaths, type TreeOperationResult } from './lib/treeSelection';\nimport './style.css';")
app = replace(app, '''type TreeActionMenu = {
  node: FileNode | null;''', '''type TreeActionMenu = {
  node: FileNode | null;
  nodes: FileNode[];''')
app = replace(app, '''type MoveDragState = {
  id: number;
  source: FileNode;''', '''type MoveDragState = {
  id: number;
  source: FileNode;
  sources: FileNode[];''')
app = replace(app, '  const [treeActionMenu, setTreeActionMenu] = useState<TreeActionMenu | null>(null);', '''  const [treeActionMenu, setTreeActionMenu] = useState<TreeActionMenu | null>(null);
  const [treeSelectionPaths, setTreeSelectionPaths] = useState<string[]>([]);
  const treeSelectionRef = useRef<string[]>([]);
  const replaceTreeSelection = useCallback((paths: string[]) => {
    treeSelectionRef.current = paths;
    setTreeSelectionPaths(paths);
  }, []);''')
app = replace(app, '  const replaceCreateDraft = useCallback((next: CreateEntryDraft | null) => {', '''  const selectedTreeNodes = useCallback((fallback?: FileNode): FileNode[] => {
    const paths = fallback && !treeSelectionRef.current.includes(normalizePath(fallback.path))
      ? [normalizePath(fallback.path)] : treeSelectionRef.current;
    return paths.map((path) => findNode(treeRef.current, path)).filter((node): node is FileNode => Boolean(node));
  }, []);

  const operationRoots = useCallback((input: FileNode | FileNode[]): FileNode[] => {
    const nodes = Array.isArray(input) ? input : [input];
    const byPath = new Map(nodes.map((node) => [normalizePath(node.path), node]));
    return topLevelSelectedPaths([...byPath.keys()]).map((path) => byPath.get(path)!);
  }, []);

  const replaceCreateDraft = useCallback((next: CreateEntryDraft | null) => {''')
app = replace(app, '  const strictSaveCurrentForRelocation = useCallback(async (', '''  const workspaceMovesProblem = useCallback((nodes: FileNode[], destinationPath: string): string | null => {
    const names: string[] = [];
    for (const node of nodes) {
      const problem = workspaceMoveProblem(node, destinationPath);
      if (problem) return `${node.name}：${problem}`;
      if (names.some((name) => name.localeCompare(node.name, undefined, { sensitivity: 'base' }) === 0)) {
        return '所选项目中有同名项，不能一起移到同一个文件夹';
      }
      names.push(node.name);
    }
    return null;
  }, [workspaceMoveProblem]);

  const strictSaveCurrentForRelocation = useCallback(async (''')
start = app.index('  const performWorkspaceMove = useCallback(')
end = app.index('  const applyConfirmedRename = useCallback(', start)
move = app[start:end]
move = replace(move, '''  const performWorkspaceMove = useCallback(async (node: FileNode, destinationPath: string) => {''', '''  const performWorkspaceMove = useCallback(async (node: FileNode, destinationPath: string): Promise<TreeOperationResult> => {
    const fail = (message: string): TreeOperationResult => {
      showNotice(message);
      return { ok: false, message };
    };''')
move = replace(move, '''    if (problem) {
      showNotice(problem);
      return;
    }''', '''    if (problem) return fail(problem);''')
move = replace(move, "      if (!await strictSaveCurrentForRelocation(sourcePath, '移动')) return;", "      if (!await strictSaveCurrentForRelocation(sourcePath, '移动')) return { ok: false, message: '当前文档未能安全保存；本地内容仍保留' };")
old = "        showNotice('工作区已经变化，已取消移动');\n        return;"
assert move.count(old) == 2
move = move.replace(old, "        return fail('工作区已经变化，已取消移动');")
move = replace(move, '''        await applyConfirmedMove(move, {
          originalPath: sourcePath,
          movedPath: move.destinationPath,
          entry: { ...node, path: move.destinationPath, name: basename(move.destinationPath) },
        });
        return;''', '''        const applied = await applyConfirmedMove(move, {
          originalPath: sourcePath,
          movedPath: move.destinationPath,
          entry: { ...node, path: move.destinationPath, name: basename(move.destinationPath) },
        });
        return applied ? { ok: true } : fail('工作区已经变化，无法确认移动结果');''')
move = replace(move, '''        showNotice('移动结果不确定；已刷新源目录和目标目录，请确认后再操作');
        return;''', '''        return fail('移动结果不确定；已刷新源目录和目标目录，请确认后再操作');''')
move = replace(move, '''      await applyConfirmedMove(move, result);
    } catch (error) {
      showNotice(moveError(error));''', '''      const applied = await applyConfirmedMove(move, result);
      return applied ? { ok: true } : fail('工作区已经变化，无法确认移动结果');
    } catch (error) {
      return fail(moveError(error));''')
batch_move = '''  const performWorkspaceMoves = useCallback(async (input: FileNode | FileNode[], destinationPath: string) => {
    const nodes = operationRoots(input);
    if (!nodes.length) return;
    if (nodes.length === 1) {
      await performWorkspaceMove(nodes[0], destinationPath);
      return;
    }
    const epoch = workspaceEpochRef.current;
    const generation = workspaceBindingRef.current?.generation;
    const current = () => !unmountedRef.current && workspaceEpochRef.current === epoch
      && workspaceBindingRef.current?.generation === generation && !workspaceTransitionRef.current;
    const problem = workspaceMovesProblem(nodes, destinationPath);
    if (problem) return void showNotice(problem);
    await runWorkspaceMutation(async () => {
      try {
        // Save a contained editor and validate every source before the first disk mutation.
        for (const node of nodes) {
          if (!current() || !findNode(treeRef.current, node.path)) {
            showNotice('工作区或所选项目已经变化，已取消批量移动');
            return;
          }
          if (!await strictSaveCurrentForRelocation(node.path, '移动')) return;
          if (desktop) {
            const candidate = await prepareWorkspaceMove(node.path, destinationPath);
            if (!current() || candidate.workspaceGeneration !== generation) {
              showNotice('工作区已经变化，已取消批量移动');
              return;
            }
          }
        }
        const result = await runTreeBatch(nodes, async (node) => {
          if (!current()) return { ok: false, message: '工作区已经变化' };
          const latest = findNode(treeRef.current, node.path);
          if (!latest) return { ok: false, message: '所选项目已经不存在' };
          return performWorkspaceMove(latest, destinationPath);
        });
        if (!current()) return;
        const paths = result.failure
          ? result.remaining.map((node) => normalizePath(node.path))
          : result.completed.map((node) => joinPath(destinationPath, basename(node.path)));
        replaceTreeSelection(paths);
        if (paths[0]) setPendingTreeFocusPath(paths[0]);
        showNotice(result.failure
          ? `已确认移动 ${result.completed.length}/${nodes.length} 项；停在“${result.remaining[0].name}”：${result.failure}；未继续处理其余项目`
          : desktop ? `已将 ${nodes.length} 项移到 ${basename(destinationPath)}`
            : `浏览器 Demo 已模拟移动 ${nodes.length} 项；未改动磁盘`);
      } catch (error) {
        showNotice(`批量移动已停止：${moveError(error)}；请检查源目录和目标目录`);
      }
    });
  }, [desktop, operationRoots, performWorkspaceMove, replaceTreeSelection, runWorkspaceMutation, showNotice, strictSaveCurrentForRelocation, workspaceMovesProblem]);

'''
app = app[:start] + move + batch_move + app[end:]
start = app.index('  const beginWorkspaceMove = useCallback(')
end = app.index('  const requestTrash = useCallback(', start)
move_entry = app[start:end]
move_entry = replace(move_entry, '  const beginWorkspaceMove = useCallback(async (node: FileNode, destinationPath: string) => {', '  const beginWorkspaceMove = useCallback(async (input: FileNode | FileNode[], destinationPath: string) => {')
move_entry = replace(move_entry, '    const problem = workspaceMoveProblem(node, destinationPath);', '    const problem = workspaceMovesProblem(operationRoots(input), destinationPath);')
move_entry = replace(move_entry, '      await performWorkspaceMove(node, destinationPath);', '      await performWorkspaceMoves(input, destinationPath);')
move_entry = replace(move_entry, '  }, [flushActiveEditorSurface, performWorkspaceMove, showNotice, workspaceMoveProblem]);', '  }, [flushActiveEditorSurface, operationRoots, performWorkspaceMoves, showNotice, workspaceMovesProblem]);')
move_entry = replace(move_entry, '  const chooseWorkspaceMoveDestination = useCallback(async (node: FileNode) => {', '  const chooseWorkspaceMoveDestination = useCallback(async (input: FileNode | FileNode[]) => {')
move_entry = replace(move_entry, '      await performWorkspaceMove(node, destination);', '      await performWorkspaceMoves(input, destination);')
move_entry = replace(move_entry, '  }, [desktop, flushActiveEditorSurface, performWorkspaceMove, showNotice]);', '  }, [desktop, flushActiveEditorSurface, performWorkspaceMoves, showNotice]);')
app = app[:start] + move_entry + app[end:]
app = replace(app, '  const treeSelectionRef = useRef<string[]>([]);', '  const treeSelectionRef = useRef<string[]>([]);\n  const trashBatchPendingRef = useRef(false);')
trash_batch = '''  const requestTrashSelection = useCallback(async (input: FileNode | FileNode[]) => {
    const nodes = operationRoots(input);
    if (!nodes.length) return;
    if (trashBatchPendingRef.current) return void showNotice('请先处理当前废纸篓操作');
    if (nodes.length === 1) {
      await requestTrash(nodes[0]);
      return;
    }
    setTreeActionMenu(null);
    if (workspaceTransitionRef.current || documentActionGateRef.current !== 'idle'
      || createBusyRef.current !== null || createDraftRef.current || renameDraftRef.current) {
      showNotice('请先完成当前操作');
      return;
    }
    const root = normalizePath(rootPathRef.current);
    if (!root || nodes.some((node) => normalizePath(node.path) === root || !containsPath(root, node.path))) {
      showNotice('不能操作工作区根目录或工作区之外的项目');
      return;
    }
    const epoch = workspaceEpochRef.current;
    const generation = workspaceBindingRef.current?.generation;
    const current = () => !unmountedRef.current && workspaceEpochRef.current === epoch
      && workspaceBindingRef.current?.generation === generation && normalizePath(rootPathRef.current) === root
      && !workspaceTransitionRef.current;
    let completedCount = 0;
    trashBatchPendingRef.current = true;
    try {
      // Capture identity-checked capabilities for every item before asking once.
      const candidates = new Map<string, Awaited<ReturnType<typeof prepareTrash>>>();
      for (const node of nodes) {
        if (!current() || !findNode(treeRef.current, node.path)) {
          showNotice('工作区或所选项目已经变化，已取消批量操作');
          return;
        }
        if (desktop) candidates.set(normalizePath(node.path), await prepareTrash(node.path));
      }
      if (!current()) return;
      const names = nodes.slice(0, 5).map((node) => `“${node.name}”`).join('、');
      const decision = await requestDecision({
        title: `将 ${nodes.length} 项移到废纸篓？`,
        message: `${names}${nodes.length > 5 ? '等' : ''}将移到 macOS 废纸篓；文件夹及其内容会一起移动，可以从废纸篓恢复。逐项执行，失败时停止，已完成的项目不会自动撤销。`,
        confirmLabel: '移到废纸篓',
        cancelLabel: '取消',
        destructive: true,
      });
      if (decision !== 'confirm') return;
      if (!current()) return void showNotice('工作区已经变化，已取消批量操作');
      const performTrashBatch = () => runWorkspaceMutation(async () => {
        const result = await runTreeBatch(nodes, async (node): Promise<TreeOperationResult> => {
          if (!current()) return { ok: false, message: '工作区已经变化' };
          const path = normalizePath(node.path);
          const parent = parentPath(path);
          directoryRefreshCoordinatorRef.current?.invalidate(parent);
          try {
            if (desktop) await moveToTrash(candidates.get(path)!);
            if (!current()) return { ok: false, message: '磁盘操作已提交，但工作区已经变化，请确认实际结果' };
            const next = removeTreePath(treeRef.current, path) as FileNode[];
            const expanded = new Set([...openFoldersRef.current].filter((item) => !containsPath(path, item)));
            treeRef.current = next;
            setTree(next);
            openFoldersRef.current = expanded;
            setOpenFolders(expanded);
            const committed = committedWorkspaceSnapshotRef.current;
            if (committed && normalizePath(committed.rootPath) === root) {
              committed.tree = removeTreePath(committed.tree, path) as FileNode[];
              committed.openFolders = new Set([...committed.openFolders].filter((item) => !containsPath(path, item)));
            }
            if (selectedRef.current && containsPath(path, selectedRef.current.path)) clearCurrentDocument();
            completedCount += 1;
            return { ok: true };
          } catch (error) {
            return { ok: false, message: trashError(error) };
          } finally {
            if (current()) directoryRefreshCoordinatorRef.current?.request([parent]);
          }
        });
        if (!current()) return;
        const remaining = result.remaining.map((node) => normalizePath(node.path));
        replaceTreeSelection(remaining);
        const focus = remaining[0] ?? parentPath(nodes[0].path);
        if (focus !== root && findNode(treeRef.current, focus)) setPendingTreeFocusPath(focus);
        else window.setTimeout(() => sidebarFocusFallbackRef.current?.focus(), 0);
        showNotice(result.failure
          ? `已移到废纸篓 ${completedCount}/${nodes.length} 项；停在“${result.remaining[0].name}”：${result.failure}；未继续处理其余项目`
          : desktop ? `已将 ${nodes.length} 项移到废纸篓`
            : `浏览器 Demo 已模拟删除 ${nodes.length} 项；未移动磁盘文件`);
      });
      const selectedPath = selectedRef.current?.path;
      if (selectedPath && nodes.some((node) => containsPath(node.path, selectedPath))) {
        await runWithSaveGuard('deleting', '移到废纸篓', performTrashBatch);
      } else {
        if (documentActionGateRef.current !== 'idle') return void showNotice('正在完成当前操作，请稍候');
        if (!flushActiveEditorSurface()) return void showNotice('表格单元格状态已经变化，无法删除其他文件');
        documentActionGateRef.current = 'deleting';
        setDocumentActionGate('deleting');
        try { await performTrashBatch(); } finally {
          documentActionGateRef.current = 'idle';
          if (!unmountedRef.current) setDocumentActionGate('idle');
        }
      }
    } catch (error) {
      showNotice(`批量废纸篓操作已停止：${trashError(error)}`);
    } finally {
      trashBatchPendingRef.current = false;
      if (!completedCount) window.setTimeout(() => {
        const trigger = lastContextTriggerRef.current;
        if (trigger?.isConnected) trigger.focus();
        else sidebarFocusFallbackRef.current?.focus();
      }, 0);
    }
  }, [clearCurrentDocument, desktop, flushActiveEditorSurface, operationRoots, replaceTreeSelection, requestDecision, requestTrash, runWithSaveGuard, runWorkspaceMutation, showNotice]);

'''
app = replace(app, '  useEffect(() => {\n    if (!treeActionMenu) return;', trash_batch + '  useEffect(() => {\n    if (!treeActionMenu) return;')
# The delete shortcut belongs to selected tree rows, never an inline/editor input.
app = replace(app, '''      const row = target?.closest<HTMLElement>('.tree-row-main[data-tree-path]');
      const path = row?.dataset.treePath;''', '''      if (event.isComposing || target?.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
      const row = target?.closest<HTMLElement>('.tree-row-main[data-tree-path]');
      const path = row?.dataset.treePath;''')
app = replace(app, '''      event.preventDefault();
      void requestTrash(node);''', '''      const nodes = selectedTreeNodes();
      if (!nodes.length) return;
      event.preventDefault();
      void requestTrashSelection(nodes);''')
app = replace(app, '  }, [requestTrash]);', '  }, [requestTrashSelection, selectedTreeNodes]);')
app = replace(app, '  const handleMoveStart = useCallback((node: FileNode) => {', '  const handleMoveStart = useCallback((node: FileNode, selection: FileNode[] = [node]) => {')
app = replace(app, '''      source: node,
      targetPath: null,''', '''      source: node,
      sources: operationRoots(selection),
      targetPath: null,''')
app = replace(app, '''  }, []);

  const handleMoveTarget = useCallback(''', '''  }, [operationRoots]);

  const handleMoveTarget = useCallback(''')
app = replace(app, '      && workspaceMoveProblem(current.source, normalizedTarget) === null;', '      && workspaceMovesProblem(current.sources, normalizedTarget) === null;')
app = replace(app, '  }, [workspaceMoveProblem]);\n\n  const handleMoveEnd', '  }, [workspaceMovesProblem]);\n\n  const handleMoveEnd')
app = replace(app, '    const source = current?.source;', '    const sources = current?.sources;')
app = replace(app, '''    if (source && allowed) {
      void beginWorkspaceMove(source, destinationPath);''', '''    if (sources?.length && allowed) {
      void beginWorkspaceMove(sources, destinationPath);''')
# Snapshot the entire context selection so async menus never read a later selection.
app = replace(app, '''    const menuWidth = 176;
    const createItems = mode === 'create' || node?.kind === 'folder';
    const menuHeight = createItems ? (mode === 'node' ? 154 : 78) : 112;''', '''    const nodes = mode === 'node' && node ? selectedTreeNodes(node) : node ? [node] : [];
    const multiple = mode === 'node' && nodes.length > 1;
    const menuWidth = 176;
    const createItems = !multiple && (mode === 'create' || node?.kind === 'folder');
    const menuHeight = multiple ? 112 : createItems ? (mode === 'node' ? 154 : 78) : 112;''')
app = replace(app, '''    setTreeActionMenu({
      node,
      parentPath:''', '''    setTreeActionMenu({
      node,
      nodes,
      parentPath:''')
app = replace(app, '  }, [cancelRename]);\n\n  const handleNodeContextMenu', '  }, [cancelRename, selectedTreeNodes]);\n\n  const handleNodeContextMenu')
app = replace(app, 'selectedPath={selected?.path ?? null} locked={treeLocked}', 'selectedPath={selected?.path ?? null} selectionPaths={treeSelectionPaths} onSelectionChange={replaceTreeSelection} locked={treeLocked}')
app = replace(app, '<div className="sidebar-footer">真实文件夹 · 无索引 · 按需读取</div>', '<div className="sidebar-footer" aria-live="polite" aria-atomic="true">{treeSelectionPaths.length ? `已选择 ${treeSelectionPaths.length} 项 · ⌘ / Shift 多选` : \'真实文件夹 · 无索引 · 按需读取\'}</div>')
app = replace(app, "      {treeActionMenu.mode === 'create' || treeActionMenu.node?.kind === 'folder' ? <>", "      {treeActionMenu.nodes.length <= 1 && (treeActionMenu.mode === 'create' || treeActionMenu.node?.kind === 'folder') ? <>")
app = replace(app, "      {treeActionMenu.mode === 'node' && treeActionMenu.node ? <>", '''      {treeActionMenu.mode === 'node' && treeActionMenu.nodes.length > 1 ? <>
        <div className="context-menu-item" aria-live="polite">已选择 {treeActionMenu.nodes.length} 项</div>
        <button ref={contextMenuItemRef} type="button" role="menuitem" className="context-menu-item" onClick={() => void chooseWorkspaceMoveDestination(treeActionMenu.nodes)}>移动到文件夹…</button>
        <button type="button" role="menuitem" className="context-menu-item destructive" onClick={() => void requestTrashSelection(treeActionMenu.nodes)}>移到废纸篓</button>
      </> : null}
      {treeActionMenu.mode === 'node' && treeActionMenu.nodes.length <= 1 && treeActionMenu.node ? <>''')
app = replace(app, 'onClick={() => void requestTrash(treeActionMenu.node!)}', 'onClick={() => void requestTrashSelection(treeActionMenu.node!)}')
# Highlight every dragged root, not only the row under the pointer.
tree = replace(tree, '  moveSourcePath: string | null;', '  moveSourcePath: string | null;\n  moveSourcePaths?: readonly string[];')
tree = replace(tree, '  moveSourcePath,\n', '  moveSourcePath,\n  moveSourcePaths,\n')
tree = replace(tree, '    const moveSource = moveSourcePath !== null && normalizePath(moveSourcePath) === path;', '    const moveSource = moveSourcePaths ? moveSourcePaths.includes(path)\n      : moveSourcePath !== null && normalizePath(moveSourcePath) === path;')
app = replace(app, 'moveSourcePath={moveDrag?.source.path ?? null}', 'moveSourcePath={moveDrag?.source.path ?? null} moveSourcePaths={moveDrag?.sources.map((node) => normalizePath(node.path))}')
tests = load('src/App.test.tsx', '5f42a373593f4cc9562cfbe485b69caaf9d52599')
tests += Path('scripts/multiselect-app-tests.txt').read_text()
Path('src/App.test.tsx').write_text(tests)
Path('src/App.tsx').write_text(app)
Path('src/components/FileTree.tsx').write_text(tree)
print('Applied directory multi-selection to App.tsx and FileTree.tsx')
