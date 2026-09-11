import {
  memo,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { retainVisibleSelection, selectTreePaths } from '../lib/treeSelection';
import type { DesktopEntry } from '../lib/desktop';
import { basename, normalizePath } from '../lib/desktop';
import { MAX_DIRECTORY_NAME_UTF16_UNITS } from '../lib/directoryName';
import { MAX_MARKDOWN_FILENAME_UTF16_UNITS } from '../lib/markdownFilename';
import TreeCreateInput, { type TreeCreateInputHandle } from './TreeCreateInput';
import TreeRenameInput, {
  type RenameCancelReason,
  type RenameSubmitReason,
  type TreeRenameInputHandle,
} from './TreeRenameInput';

export type FileTreeNode = DesktopEntry & {
  children?: FileTreeNode[];
  loaded?: boolean;
  demoContent?: string;
};

export type TreeCreateKind = 'markdown' | 'folder';

export const LOCALVIEW_TREE_DRAG_TYPE = 'application/x-localview-tree-entry';
export const MOVE_HOVER_OPEN_DELAY_MS = 650;

export function isLocalTreeDrag(dataTransfer: DataTransfer, currentSourcePath: string | null): boolean {
  return currentSourcePath !== null
    || Array.from(dataTransfer.types).includes(LOCALVIEW_TREE_DRAG_TYPE);
}

export type FileTreeCreateDraft = {
  id: number;
  parentPath: string;
  kind: TreeCreateKind;
};

export type FileTreeRenameDraft = {
  id: number;
  sourcePath: string;
  editableName: string;
  lockedSuffix: string;
  surface?: 'tree' | 'toolbar';
};

type Props = {
  tree: FileTreeNode[];
  rootPath: string;
  openFolders: Set<string>;
  selectedPath: string | null;
  selectionPaths?: readonly string[];
  onSelectionChange?: (paths: string[]) => void;
  locked: boolean;
  createDraft: FileTreeCreateDraft | null;
  createBusy: boolean;
  createInvalid: boolean;
  preparingFolders: Set<string>;
  createInputRef: RefObject<TreeCreateInputHandle>;
  renameDraft: FileTreeRenameDraft | null;
  renameBusy: boolean;
  renameInvalid: boolean;
  renameInputRef: RefObject<TreeRenameInputHandle>;
  focusPath: string | null;
  moveSourcePath: string | null;
  moveSourcePaths?: readonly string[];
  moveTargetPath: string | null;
  moveTargetAllowed: boolean;
  moveDragId: number | null;
  onFocusHandled: () => void;
  onNodeClick: (node: FileTreeNode) => void;
  onNodeContextMenu: (event: MouseEvent<HTMLElement>, node: FileTreeNode) => void;
  onOpenCreateMenu: (event: MouseEvent<HTMLButtonElement>, path: string, node: FileTreeNode) => void;
  onOpenNodeMenu: (event: MouseEvent<HTMLButtonElement>, node: FileTreeNode) => void;
  onSubmitCreate: (value: string) => void;
  onCancelCreate: () => void;
  onBeginRename: (node: FileTreeNode) => void;
  onSubmitRename: (value: string, reason: RenameSubmitReason) => void;
  onCancelRename: (reason: RenameCancelReason) => void;
  onMoveStart: (node: FileTreeNode, selection?: FileTreeNode[]) => boolean;
  onMoveTarget: (path: string | null) => boolean;
  onMoveHoverExpand: (node: FileTreeNode, dragId: number, targetPath: string) => void;
  onMoveDrop: (path: string) => void;
  onMoveEnd: () => void;
};

function FileTree({
  tree,
  rootPath,
  openFolders,
  selectedPath,
  selectionPaths,
  onSelectionChange,
  locked,
  createDraft,
  createBusy,
  createInvalid,
  preparingFolders,
  createInputRef,
  renameDraft,
  renameBusy,
  renameInvalid,
  renameInputRef,
  focusPath,
  moveSourcePath,
  moveSourcePaths,
  moveTargetPath,
  moveTargetAllowed,
  moveDragId,
  onFocusHandled,
  onNodeClick,
  onNodeContextMenu,
  onOpenCreateMenu,
  onOpenNodeMenu,
  onSubmitCreate,
  onCancelCreate,
  onBeginRename,
  onSubmitRename,
  onCancelRename,
  onMoveStart,
  onMoveTarget,
  onMoveHoverExpand,
  onMoveDrop,
  onMoveEnd,
}: Props) {
  const [fallbackSelection, setFallbackSelection] = useState<string[]>([]);
  const selection = selectionPaths ?? fallbackSelection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectionCallbackRef = useRef(onSelectionChange);
  selectionCallbackRef.current = onSelectionChange;
  const anchorRef = useRef<string | null>(null);
  const pointerFocusRef = useRef(false);
  const previousContextRef = useRef({ root: '', document: null as string | null, creating: false });
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
    const creating = createBusy || createDraft !== null;
    const previous = previousContextRef.current;
    previousContextRef.current = { root, document, creating };
    let next = retainVisibleSelection(selectionRef.current, visiblePaths);
    // Creation commits the selected document before releasing its interaction lock.
    // A locked group is otherwise owned by the immutable batch-operation snapshot.
    const followDocument = !locked || selectionRef.current.length <= 1 || creating || previous.creating;
    if (previous.root !== root || (previous.document !== document && followDocument)) {
      next = document && visiblePaths.includes(document) ? [document] : [];
      anchorRef.current = next[0] ?? null;
    } else if (anchorRef.current && !visiblePaths.includes(anchorRef.current)) {
      anchorRef.current = null;
    }
    replaceSelection(next);
  }, [rootPath, selectedPath, visiblePaths, selection, locked, createBusy, createDraft, replaceSelection]);

  useEffect(() => {
    const releasePointer = () => { pointerFocusRef.current = false; };
    window.addEventListener('pointerup', releasePointer, true);
    window.addEventListener('pointercancel', releasePointer, true);
    window.addEventListener('mouseup', releasePointer, true);
    window.addEventListener('dragend', releasePointer, true);
    window.addEventListener('blur', releasePointer);
    return () => {
      window.removeEventListener('pointerup', releasePointer, true);
      window.removeEventListener('pointercancel', releasePointer, true);
      window.removeEventListener('mouseup', releasePointer, true);
      window.removeEventListener('dragend', releasePointer, true);
      window.removeEventListener('blur', releasePointer);
    };
  }, []);

  const selectRow = (path: string, modifiers: { toggle?: boolean; range?: boolean } = {}) => {
    const next = selectTreePaths(visiblePaths, selectionRef.current, anchorRef.current, path, modifiers);
    anchorRef.current = next.anchor;
    replaceSelection(next.paths);
  };
  const selectForAction = (path: string) => {
    if (!selectionRef.current.includes(path)) selectRow(path);
  };

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverExpandRef = useRef<{ path: string; dragId: number; timer: number } | null>(null);
  const activeDragSourceRef = useRef<string | null>(null);

  const clearHoverExpand = (path?: string) => {
    const pending = hoverExpandRef.current;
    if (!pending || (path !== undefined && pending.path !== path)) return;
    window.clearTimeout(pending.timer);
    hoverExpandRef.current = null;
  };

  const scheduleHoverExpand = (
    node: FileTreeNode,
    path: string,
    expanded: boolean,
    allowed: boolean,
  ) => {
    const dragId = moveDragId;
    if (expanded || !allowed || dragId === null) {
      clearHoverExpand();
      return;
    }
    if (hoverExpandRef.current?.path === path && hoverExpandRef.current.dragId === dragId) return;
    clearHoverExpand();
    const timer = window.setTimeout(() => {
      if (hoverExpandRef.current?.path !== path || hoverExpandRef.current.dragId !== dragId) return;
      hoverExpandRef.current = null;
      onMoveHoverExpand(node, dragId, path);
    }, MOVE_HOVER_OPEN_DELAY_MS);
    hoverExpandRef.current = { path, dragId, timer };
  };

  useEffect(() => () => {
    if (hoverExpandRef.current) window.clearTimeout(hoverExpandRef.current.timer);
  }, []);

  useEffect(() => {
    if (moveSourcePath === null) {
      activeDragSourceRef.current = null;
      clearHoverExpand();
    }
  }, [moveSourcePath]);

  useLayoutEffect(() => {
    if (!focusPath) return;
    const path = normalizePath(focusPath);
    rowRefs.current.get(path)?.focus();
    if (!locked && visiblePaths.includes(path) && !selectionRef.current.includes(path)) {
      anchorRef.current = path;
      replaceSelection([path]);
    }
    onFocusHandled();
  }, [focusPath, onFocusHandled, tree, locked, visiblePaths, replaceSelection]);

  const renderCreateEditor = (depth: number) => {
    if (!createDraft) return null;
    const folder = createDraft.kind === 'folder';
    return <div className="tree-create-editor" style={{ paddingLeft: 8 + depth * 16 }}>
      <TreeCreateInput
        key={createDraft.id}
        ref={createInputRef}
        ariaLabel={`在 ${basename(createDraft.parentPath)} 中${folder ? '新建文件夹' : '新建 Markdown 文件'}`}
        disabled={createBusy || locked}
        invalid={createInvalid}
        maxLength={folder ? MAX_DIRECTORY_NAME_UTF16_UNITS : MAX_MARKDOWN_FILENAME_UTF16_UNITS}
        placeholder={folder ? '新建文件夹' : 'untitled.md'}
        onSubmit={onSubmitCreate}
        onCancel={onCancelCreate}
      />
    </div>;
  };

  const renderNodes = (nodes: FileTreeNode[], depth = 0): ReactNode => nodes.map((node) => {
    const path = normalizePath(node.path);
    const expanded = openFolders.has(path);
    const currentDocument = selectedPath !== null && normalizePath(selectedPath) === path;
    const active = selectedPaths.has(path);
    const moveSource = moveSourcePaths ? moveSourcePaths.includes(path)
      : moveSourcePath !== null && normalizePath(moveSourcePath) === path;
    const moveTarget = moveTargetPath !== null && normalizePath(moveTargetPath) === path;
    const moveAllowed = moveTarget && moveTargetAllowed;
    const renaming = renameDraft !== null
      && renameDraft.surface !== 'toolbar'
      && normalizePath(renameDraft.sourcePath) === path;
    return <div key={path}>
      <div
        className={`tree-row ${node.kind === 'folder' ? 'folder' : ''} ${active ? 'active' : ''}${moveSource ? ' move-source' : ''}${moveTarget ? moveAllowed ? ' move-target-valid' : ' move-target-invalid' : ''}`}
        onDragEnter={(event) => {
          const currentSourcePath = activeDragSourceRef.current ?? moveSourcePath;
          if (node.kind !== 'folder' || !isLocalTreeDrag(event.dataTransfer, currentSourcePath)) return;
          event.preventDefault();
          const allowed = onMoveTarget(path);
          event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
          scheduleHoverExpand(node, path, expanded, allowed);
        }}
        onDragOver={(event) => {
          const currentSourcePath = activeDragSourceRef.current ?? moveSourcePath;
          if (node.kind !== 'folder' || !isLocalTreeDrag(event.dataTransfer, currentSourcePath)) return;
          event.preventDefault();
          const allowed = onMoveTarget(path);
          event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
          scheduleHoverExpand(node, path, expanded, allowed);
        }}
        onDragLeave={(event) => {
          if (node.kind !== 'folder') return;
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
          clearHoverExpand(path);
          if (moveTargetPath !== null && normalizePath(moveTargetPath) === path) onMoveTarget(null);
        }}
        onDrop={(event) => {
          const currentSourcePath = activeDragSourceRef.current ?? moveSourcePath;
          if (node.kind !== 'folder' || !isLocalTreeDrag(event.dataTransfer, currentSourcePath)) return;
          event.preventDefault();
          clearHoverExpand(path);
          activeDragSourceRef.current = null;
          if (onMoveTarget(path)) onMoveDrop(path);
          else onMoveEnd();
        }}
      >
        <div
          ref={(element) => {
            if (element) rowRefs.current.set(path, element);
            else rowRefs.current.delete(path);
          }}
          role="button"
          tabIndex={locked || renameBusy || renaming ? -1 : 0}
          className={`tree-row-main${active ? ' active' : ''}`}
          data-tree-path={path}
          style={{ paddingLeft: 8 + depth * 16 }}
          aria-disabled={locked ? true : undefined}
          aria-expanded={node.kind === 'folder' ? expanded : undefined}
          aria-current={currentDocument ? 'page' : undefined}
          aria-pressed={active}
          draggable={!locked && createDraft === null && renameDraft === null}
          onFocus={(event) => {
            // Pointer focus precedes click; selecting here would double-toggle Cmd-click
            // and collapse a group before dragstart. Keyboard/programmatic focus selects.
            if (event.target !== event.currentTarget || pointerFocusRef.current || locked
              || renameBusy || createDraft !== null || renameDraft !== null) return;
            selectForAction(path);
          }}
          onClick={(event) => {
            if (event.detail > 1 || locked || renaming) return;
            const modified = event.metaKey || event.ctrlKey || event.shiftKey;
            if (modified && (renameBusy || createDraft !== null || renameDraft !== null)) return;
            selectRow(path, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey });
            // App queues ordinary navigation behind an in-flight blur rename.
            if (!modified) onNodeClick(node);
          }}
          onDoubleClick={(event) => {
            if (locked || renameBusy || createDraft !== null || renameDraft !== null
              || event.metaKey || event.ctrlKey || event.shiftKey || selectionRef.current.length > 1) return;
            const target = event.target;
            if (!(target instanceof HTMLElement) || !target.closest('.tree-name')) return;
            event.preventDefault();
            event.stopPropagation();
            onBeginRename(node);
          }}
          onKeyDown={(event) => {
            pointerFocusRef.current = false;
            if (locked || renameBusy || event.nativeEvent.isComposing) return;
            const target = event.target;
            if (target instanceof HTMLInputElement
              || target instanceof HTMLTextAreaElement
              || (target instanceof HTMLElement
                && (target.isContentEditable || target.closest('.cm-editor')))) return;
            if (createDraft === null && renameDraft === null) {
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
            if (event.key === 'F2' && createDraft === null && renameDraft === null) {
              event.preventDefault();
              if (selectionRef.current.length > 1) return;
              selectForAction(path);
              onBeginRename(node);
              return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            selectRow(path);
            onNodeClick(node);
          }}
          onContextMenu={(event) => {
            if (locked || renameBusy) {
              event.preventDefault();
              return;
            }
            selectForAction(path);
            onNodeContextMenu(event, node);
          }}
          onDragStart={(event) => {
            if (locked || createDraft !== null || renameDraft !== null) {
              event.preventDefault();
              return;
            }
            selectForAction(path);
            const dragSelection = visibleNodes.filter((item) => selectionRef.current.includes(normalizePath(item.path)));
            if (!onMoveStart(node, dragSelection)) {
              event.preventDefault();
              return;
            }
            activeDragSourceRef.current = path;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(LOCALVIEW_TREE_DRAG_TYPE, path);
            event.dataTransfer.setData('text/plain', dragSelection.map((item) => item.path).join('\n'));
          }}
          onDragEnd={() => {
            pointerFocusRef.current = false;
            activeDragSourceRef.current = null;
            clearHoverExpand();
            onMoveEnd();
          }}
        >
          {renaming ? <TreeRenameInput
            key={renameDraft.id}
            ref={renameInputRef}
            ariaLabel={`重命名 ${node.name}`}
            disabled={renameBusy}
            invalid={renameInvalid}
            initialValue={renameDraft.editableName}
            lockedSuffix={renameDraft.lockedSuffix}
            maxLength={255}
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          /> : <>
            {node.kind === 'folder'
              ? <span className="tree-icon" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              : null}
            <span className="tree-name">{node.name}</span>
          </>}
        </div>
        {!renaming ? <div className="tree-row-actions">
          {node.kind === 'folder' ? <button
              className="tree-action-button tree-create-button"
              type="button"
              disabled={createBusy || renameBusy || renameDraft !== null || locked || preparingFolders.has(path)}
              aria-busy={preparingFolders.has(path)}
              aria-label={`在 ${node.name} 中新建`}
              onClick={(event) => onOpenCreateMenu(event, path, node)}
            >+</button> : null}
          <button
            className="tree-action-button tree-more-button"
            type="button"
            disabled={createBusy || renameBusy || renameDraft !== null || locked}
            aria-label={node.kind === 'folder' ? `${node.name} 文件夹操作` : `${node.name} 操作`}
            onClick={(event) => {
              selectForAction(path);
              onOpenNodeMenu(event, node);
            }}
          >•••</button>
        </div> : null}
      </div>
      {node.kind === 'folder' && expanded && createDraft?.parentPath === path
        ? renderCreateEditor(depth + 1)
        : null}
      {node.kind === 'folder' && expanded && node.children ? renderNodes(node.children, depth + 1) : null}
    </div>;
  });

  return <div className="file-tree" role="group" aria-label="文件与文件夹（支持多选）"
    onPointerDownCapture={() => { pointerFocusRef.current = true; }}
    onMouseDownCapture={() => { pointerFocusRef.current = true; }}
    onClick={(event) => {
      if (event.target === event.currentTarget && !locked && !createDraft && !renameDraft) {
        anchorRef.current = null;
        replaceSelection([]);
      }
    }}
  >
    {createDraft?.parentPath === normalizePath(rootPath) ? renderCreateEditor(0) : null}
    {tree.length ? renderNodes(tree) : <div className="tree-empty">打开文件夹后显示真实目录树</div>}
  </div>;
}

export default memo(FileTree);
